// Monotonicity check for the Client version identity.
//
// `client-version.json` is the Client's single source of truth. A running Client
// announces its version with every Service request, so the version must never go
// backwards, and it must strictly increase whenever the `api` specification
// gitlink moves: one Client version cannot stand for two different API surfaces.
//
// The check treats the current working directory as the repository root (where CI
// invokes it and where a temporary repository stands in during tests). The current
// identity is read from `HEAD`, never from a working-tree file that a change could
// leave behind, and the `api` gitlink is read from the index of that same checkout.
//
// Base resolution is fail-closed inside GitHub Actions: a pull request or the
// merge queue's `merge_group` compares against `origin/main`, and a push
// compares against the event's `before` revision, where an all-zero `before`
// means the push introduces the ref. A `workflow_dispatch` is an explicit
// build/release trigger with no base revision, so it validates HEAD and states
// that no comparison was made; any other trigger, a malformed event payload or
// an unresolvable revision fails the check instead of skipping it. Local runs
// outside Actions skip only the base comparison; the current identity is still
// validated.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseClientVersion } from './client-version.mjs';
import { readSubmoduleRevision } from './source-ci-credential-boundary.mjs';

export const CLIENT_VERSION_FILE = 'client-version.json';
export const API_SUBMODULE_PATH = 'api';

const commitPattern = /^[0-9a-f]{40}$/;
const zeroCommit = '0'.repeat(40);

export class ClientVersionBumpError extends Error {}

/** Runs one git command in `root`, optionally returning undefined instead of failing. */
function git(root, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error) {
    throw new ClientVersionBumpError(`git ${args.join(' ')} could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (allowFailure) return undefined;
    const detail = (result.stderr ?? '').trim();
    throw new ClientVersionBumpError(`git ${args.join(' ')} failed${detail === '' ? '' : `: ${detail}`}`);
  }
  return result.stdout;
}

/** Resolves `revision` to a full commit SHA, or fails closed. */
export function resolveRevision(root, revision) {
  const output = git(root, ['rev-parse', '--verify', `${revision}^{commit}`], { allowFailure: true });
  if (output === undefined || output.trim() === '') {
    throw new ClientVersionBumpError(`revision '${revision}' cannot be resolved`);
  }
  return output.trim();
}

/** The `client_version` recorded at `HEAD`; a missing or malformed file fails. */
export function readHeadClientVersion(root) {
  resolveRevision(root, 'HEAD');
  const source = git(root, ['show', `HEAD:${CLIENT_VERSION_FILE}`], { allowFailure: true });
  if (source === undefined) {
    throw new ClientVersionBumpError(`${CLIENT_VERSION_FILE} is missing or unreadable at HEAD`);
  }
  return parseClientVersion(source);
}

/** The `client_version` recorded at `revision`, or undefined when the file is absent. */
export function readClientVersionAt(root, revision) {
  const source = git(root, ['show', `${revision}:${CLIENT_VERSION_FILE}`], { allowFailure: true });
  return source === undefined ? undefined : parseClientVersion(source);
}

/** The `api` gitlink in `git ls-tree` output, or undefined when it is absent. */
export function parseApiRevisionFromLsTree(output) {
  const entries = output.split('\n').filter((line) => line !== '');
  if (entries.length === 0) return undefined;
  if (entries.length > 1) {
    throw new ClientVersionBumpError(
      `git ls-tree returned ${entries.length} entries for '${API_SUBMODULE_PATH}'; expected at most one`,
    );
  }
  const match = /^160000 commit ([0-9a-f]{40})\tapi$/.exec(entries[0]);
  if (!match) {
    throw new ClientVersionBumpError(`git ls-tree returned an unreadable '${API_SUBMODULE_PATH}' entry: ${entries[0]}`);
  }
  return match[1];
}

/** The `api` gitlink recorded at `revision`, or undefined when the submodule is absent. */
export function readApiRevisionAt(root, revision) {
  return parseApiRevisionFromLsTree(git(root, ['ls-tree', revision, '--', API_SUBMODULE_PATH]));
}

/** The `api` gitlink in this checkout's index. */
export async function readCurrentApiRevision(root) {
  try {
    return await readSubmoduleRevision(pathToFileURL(`${resolve(root)}${sep}`), API_SUBMODULE_PATH);
  } catch (error) {
    throw new ClientVersionBumpError(
      `cannot read the '${API_SUBMODULE_PATH}' gitlink from this checkout's index: ${error.message}`,
    );
  }
}

/**
 * The revision the current identity is compared against.
 *
 * Returns `{ mode: 'local' }` outside Actions, `{ mode: 'no-base' }` for a
 * `workflow_dispatch` (an explicit trigger with no comparison base),
 * `{ mode: 'first-introduction' }` when a push introduces the ref, and
 * `{ mode: 'revision', revision }` otherwise.
 */
export function resolvePreviousRevision(environment = {}, event) {
  if (environment.GITHUB_ACTIONS !== 'true') return { mode: 'local' };

  const eventName = environment.GITHUB_EVENT_NAME;
  if (eventName === 'pull_request') return { mode: 'revision', revision: 'origin/main' };
  // The merge queue's serial re-test re-validates the same comparison as the
  // pull request it carries: the queue's temporary branch is main plus the
  // queued PR, and the workflow checkout's `fetch-depth: 0` keeps `origin/main`
  // resolvable there.
  if (eventName === 'merge_group') return { mode: 'revision', revision: 'origin/main' };
  // A workflow_dispatch is an explicit build/release trigger, not a change event:
  // it has no comparison base, so validate HEAD and report that nothing was
  // compared instead of pretending to compare or failing closed.
  if (eventName === 'workflow_dispatch') return { mode: 'no-base' };
  if (eventName === 'push') {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new ClientVersionBumpError('the push event payload is missing or malformed');
    }
    const before = event.before;
    if (typeof before !== 'string' || (before !== zeroCommit && !commitPattern.test(before))) {
      throw new ClientVersionBumpError("the push event payload 'before' is not a full commit SHA");
    }
    if (before === zeroCommit) return { mode: 'first-introduction' };
    return { mode: 'revision', revision: before };
  }

  throw new ClientVersionBumpError(
    `GITHUB_EVENT_NAME=${eventName ?? '(unset)'} is not pull_request, merge_group, push or workflow_dispatch; refusing to skip the base comparison`,
  );
}

/** Reads and parses the event payload named by `GITHUB_EVENT_PATH`. */
export function readEventPayload(environment = {}, readFile = readFileSync) {
  const eventPath = environment.GITHUB_EVENT_PATH;
  if (typeof eventPath !== 'string' || eventPath === '') {
    throw new ClientVersionBumpError('GITHUB_EVENT_PATH is not set for a push event');
  }
  let source;
  try {
    source = readFile(eventPath, 'utf8');
  } catch {
    throw new ClientVersionBumpError(`the push event payload at ${eventPath} cannot be read`);
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new ClientVersionBumpError(`the push event payload at ${eventPath} is not valid JSON`);
  }
}

function isClientVersion(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The pure comparison rule: the version never decreases, and a moved `api`
 * gitlink (including a previous gitlink that is absent) requires a strict
 * increase. Returns every violation, so the check reports all of them at once.
 */
export function evaluateClientVersionBump({
  current,
  previous,
  currentApiRevision,
  previousApiRevision,
}) {
  const violations = [];
  if (!isClientVersion(current)) {
    violations.push(`HEAD client_version ${String(current)} is not a non-negative safe integer`);
  }
  if (!isClientVersion(previous)) {
    violations.push(`previous client_version ${String(previous)} is not a non-negative safe integer`);
  }
  if (typeof currentApiRevision !== 'string' || !commitPattern.test(currentApiRevision)) {
    violations.push(`HEAD records no valid '${API_SUBMODULE_PATH}' gitlink`);
  }
  if (previousApiRevision !== undefined
    && (typeof previousApiRevision !== 'string' || !commitPattern.test(previousApiRevision))) {
    violations.push(`the previous revision records no valid '${API_SUBMODULE_PATH}' gitlink`);
  }

  if (isClientVersion(current) && isClientVersion(previous) && current < previous) {
    violations.push(
      `client_version decreased from ${previous} to ${current}; a published Client version cannot be reused or lowered`,
    );
  }
  if (isClientVersion(current)
    && isClientVersion(previous)
    && currentApiRevision !== previousApiRevision
    && current <= previous) {
    violations.push(
      `the '${API_SUBMODULE_PATH}' gitlink moved (${previousApiRevision ?? 'absent'} -> ${currentApiRevision}), `
      + `so client_version must strictly increase (previous ${previous}, HEAD ${current})`,
    );
  }
  return violations;
}

/**
 * Runs the whole check against the repository rooted at `root` and returns the
 * evidence. Fail-closed conditions throw; rule violations are returned.
 */
export async function runClientVersionBump({
  root = process.cwd(),
  environment = process.env,
  readFile = readFileSync,
} = {}) {
  const current = readHeadClientVersion(root);
  const event = environment.GITHUB_ACTIONS === 'true' && environment.GITHUB_EVENT_NAME === 'push'
    ? readEventPayload(environment, readFile)
    : undefined;
  const base = resolvePreviousRevision(environment, event);

  if (base.mode === 'local' || base.mode === 'no-base') {
    return { compared: false, reason: base.mode, current, violations: [] };
  }

  let previous = 0;
  let previousRevision;
  let previousApiRevision;
  if (base.mode === 'revision') {
    previousRevision = resolveRevision(root, base.revision);
    previous = readClientVersionAt(root, previousRevision) ?? 0;
    previousApiRevision = readApiRevisionAt(root, previousRevision);
  }

  const currentApiRevision = await readCurrentApiRevision(root);
  const violations = evaluateClientVersionBump({
    current,
    previous,
    currentApiRevision,
    previousApiRevision,
  });

  return {
    compared: true,
    current,
    previous,
    previousRevision,
    currentApiRevision,
    previousApiRevision,
    violations,
  };
}

/** CLI entry point: prints the evidence and sets `process.exitCode`. */
export async function main({
  root = process.cwd(),
  environment = process.env,
  log = console.log,
  error = console.error,
} = {}) {
  let exitCode = 1;
  try {
    const result = await runClientVersionBump({ root, environment });
    if (!result.compared) {
      if (result.reason === 'no-base') {
        log(`client_version ${result.current}: base comparison skipped because workflow_dispatch has no base revision; HEAD identity validated`);
      } else {
        log(`client_version ${result.current}: base comparison skipped (local-only) because GITHUB_ACTIONS is not 'true'`);
      }
      exitCode = 0;
    } else if (result.violations.length > 0) {
      for (const violation of result.violations) error(`::error::${violation}`);
    } else {
      log(`client_version ${result.previous} -> ${result.current} (base ${result.previousRevision})`);
      log(`api gitlink ${result.previousApiRevision ?? 'absent'} -> ${result.currentApiRevision}`);
      log('Client version bump check passed');
      exitCode = 0;
    }
  } catch (failure) {
    error(`::error::${failure instanceof Error ? failure.message : String(failure)}`);
  }
  process.exitCode = exitCode;
  return exitCode;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  await main();
}
