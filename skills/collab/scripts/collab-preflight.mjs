/**
 * collab-preflight.mjs — six-point preflight for github:files transport (v1.0 §6.1).
 *
 * Checks before kickoff (or any mutation-requiring operation):
 *   1. Entrypoint resolves to the expected collab plugin (not a stale path)
 *   2. Installed plugin version >= minimum required (with path-based fallback)
 *   3. Route dry-run (slug uniqueness across transports)
 *   4. Local write test (write + delete a temp file in the collab dir)
 *   5. Pull/rebase (git pull --rebase succeeds)
 *   6. Push dry-run (git push --dry-run) — logs warning if not possible, doesn't hard-block
 *
 * Also (all transports): slug unique, kickoff justification required if new multi-agent collab.
 *
 * Returns { pass: bool, blockers: [{code, message}], warnings: [{code, message}] }
 */

import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  findCollabAcrossTransports, readLocalPluginVersionInfo, checkMinVersion,
} from './collab-event-helpers.mjs';
import { isGitTransport } from './transport.mjs';

export const PREFLIGHT_CODES = {
  ENTRYPOINT_MISMATCH: 'entrypoint-mismatch',
  VERSION_TOO_LOW: 'version-too-low',
  SLUG_COLLISION: 'slug-collision',
  SLUG_NOT_FOUND: 'slug-not-found',
  LOCAL_WRITE_FAILED: 'local-write-failed',
  PULL_REBASE_FAILED: 'pull-rebase-failed',
  PUSH_DRY_RUN_FAILED: 'push-dry-run-failed',
  MISSING_JUSTIFICATION: 'missing-justification',
};

/**
 * Run the six-point preflight.
 * @param {object} opts
 * @param {string} opts.slug — collab slug
 * @param {string} [opts.minVersion] — minimum required plugin version
 * @param {string} [opts.justification] — kickoff justification.reason (required for new multi-agent collabs)
 * @param {boolean} [opts.isNewCollab=false] — true if this is a new kickoff
 * @param {string} [opts.selfPath] — path to this script file (for entrypoint check); defaults to import.meta.url
 * @param {object} [opts._env] — injected environment for testing
 * @returns {{ pass: boolean, blockers: Array<{code, message}>, warnings: Array<{code, message}> }}
 */
export function runPreflight(opts) {
  const {
    slug, minVersion = null, justification = null, isNewCollab = false,
    selfPath, _env,
  } = opts;
  const blockers = [];
  const warnings = [];

  // 1. Entrypoint resolution — confirm this script is being loaded from a real collab plugin install,
  //    not a stale/symlinked path. The check: the scripts/ dir we're in should contain
  //    collab-tick.mjs (a sibling), confirming we're in a coherent plugin install.
  const scriptDir = selfPath
    ? dirname(selfPath)
    : (() => { try { return dirname(fileURLToPath(import.meta.url)); } catch { return null; } })();
  if (scriptDir && !existsSync(join(scriptDir, 'collab-tick.mjs'))) {
    blockers.push({
      code: PREFLIGHT_CODES.ENTRYPOINT_MISMATCH,
      message: `preflight script dir ${scriptDir} is missing collab-tick.mjs — entrypoint may be stale`,
    });
  }

  // 2. Version check
  if (minVersion) {
    const info = readLocalPluginVersionInfo();
    const check = checkMinVersion(info, minVersion);
    if (!check.ok) {
      blockers.push({ code: PREFLIGHT_CODES.VERSION_TOO_LOW, message: check.error });
    }
  }

  // 3. Route dry-run — slug must exist (resume) or be unique across transports (new kickoff)
  const hit = findCollabAcrossTransports(slug);
  if (!isNewCollab && !hit) {
    blockers.push({ code: PREFLIGHT_CODES.SLUG_NOT_FOUND, message: `no collab directory found for slug: ${slug}` });
  }
  if (isNewCollab && hit) {
    blockers.push({ code: PREFLIGHT_CODES.SLUG_COLLISION, message: `slug ${slug} already exists at ${hit.dir}` });
  }

  // Justification required for new multi-agent collabs
  if (isNewCollab && !justification) {
    blockers.push({
      code: PREFLIGHT_CODES.MISSING_JUSTIFICATION,
      message: 'new multi-agent collab requires justification.reason in kickoff payload',
    });
  }

  // Checks 4–6 require the collab dir (skip on new collab that doesn't exist yet)
  const collabDir = hit?.dir;
  const transport = hit?.transport;
  const useGitTransport = isGitTransport(transport);

  if (collabDir) {
    // 4. Local write test
    const probe = join(collabDir, `.preflight-probe-${randomBytes(2).toString('hex')}`);
    try {
      writeFileSync(probe, 'preflight');
      unlinkSync(probe);
    } catch (e) {
      blockers.push({ code: PREFLIGHT_CODES.LOCAL_WRITE_FAILED, message: `cannot write to collab dir: ${e.message}` });
    }

    if (useGitTransport) {
      // Resolve the git repo root (parent of collabs/ dir)
      const repoRoot = _repoForTransport(transport, collabDir, _env);

      // 5. Pull/rebase
      const pull = spawnSync('git', ['pull', '--rebase'], {
        cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ...(_env || {}) },
      });
      if (pull.status !== 0) {
        blockers.push({
          code: PREFLIGHT_CODES.PULL_REBASE_FAILED,
          message: `git pull --rebase failed: ${(pull.stderr || pull.stdout || '').trim().slice(0, 200)}`,
        });
      }

      // 6. Push dry-run — warning (not blocker) because push rights vary
      const push = spawnSync('git', ['push', '--dry-run'], {
        cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ...(_env || {}) },
      });
      if (push.status !== 0) {
        warnings.push({
          code: PREFLIGHT_CODES.PUSH_DRY_RUN_FAILED,
          message: `git push --dry-run failed (push may fail at commit time): ${(push.stderr || '').trim().slice(0, 200)}`,
        });
      }
    }
  }

  return { pass: blockers.length === 0, blockers, warnings };
}

/**
 * Derive the git repo root from a transport string and the collab dir.
 * For github: transports, the repo is the parent of the 'collabs/' directory.
 */
function _repoForTransport(transport, collabDir, _env) {
  // collabDir is like ~/Documents/Projects/files/collabs/<slug>
  // repo root is ~/Documents/Projects/files
  if (collabDir) {
    const parts = collabDir.split('/');
    const collabsIdx = parts.lastIndexOf('collabs');
    if (collabsIdx >= 0) return parts.slice(0, collabsIdx).join('/');
  }
  // Fallback: ask git
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: collabDir || process.cwd(), encoding: 'utf8',
    env: { ...process.env, ...(_env || {}) },
  });
  return (res.stdout || '').trim() || collabDir;
}
