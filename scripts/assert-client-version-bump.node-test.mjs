// Offline tests for the Client version monotonicity rule.
//
// The pure cases pin the two invariants: a client version never decreases, and a
// moved `api` gitlink requires a strict increase. The repository cases build a
// throwaway git repository so trigger resolution, `HEAD` reading, the event
// payload path and the previous gitlink parse are exercised against real git
// objects rather than doubles.
//
// Run with `pnpm run test:run`, which includes this file in its `node --test` list.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  evaluateClientVersionBump,
  main,
  parseApiRevisionFromLsTree,
  readEventPayload,
  readHeadClientVersion,
  resolvePreviousRevision,
  runClientVersionBump,
} from './assert-client-version-bump.mjs';

const apiRevisionA = 'a'.repeat(40);
const apiRevisionB = 'b'.repeat(40);
const zeroCommit = '0'.repeat(40);

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed in ${root}: ${result.stderr}`);
  return result.stdout;
}

/** Commits with an explicit identity so a fresh runner needs no global git config. */
function commit(root, message) {
  const result = spawnSync('git', [
    '-c', 'user.name=anywear-test',
    '-c', 'user.email=test@anywear.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '--no-verify', '-m', message,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `git commit failed in ${root}: ${result.stderr}`);
  return git(root, ['rev-parse', 'HEAD']).trim();
}

async function temporaryRepository(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-client-version-bump-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // The branch name is explicit; no default-branch configuration is assumed.
  git(directory, ['init', '-q', '-b', 'main']);
  return directory;
}

function writeVersion(root, version) {
  return writeFile(
    join(root, 'client-version.json'),
    `{\n  "schema_version": 1,\n  "client_version": ${version}\n}\n`,
    'utf8',
  );
}

function setApiGitlink(root, revision) {
  git(root, ['update-index', '--add', '--cacheinfo', `160000,${revision},api`]);
}

// ---------------------------------------------------------------------------
// The pure rule
// ---------------------------------------------------------------------------

test('accepts a same-version comparison only while the api gitlink is unchanged', () => {
  assert.deepEqual(evaluateClientVersionBump({
    current: 1,
    previous: 1,
    currentApiRevision: apiRevisionA,
    previousApiRevision: apiRevisionA,
  }), []);

  assert.match(evaluateClientVersionBump({
    current: 1,
    previous: 1,
    currentApiRevision: apiRevisionB,
    previousApiRevision: apiRevisionA,
  }).join('\n'), /strictly increase/);
});

test('rejects a decreased version even when the api gitlink is unchanged', () => {
  const violations = evaluateClientVersionBump({
    current: 1,
    previous: 2,
    currentApiRevision: apiRevisionA,
    previousApiRevision: apiRevisionA,
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /decreased from 2 to 1/);
});

test('requires a strict increase when the api gitlink moves, including a first introduction', () => {
  assert.deepEqual(evaluateClientVersionBump({
    current: 2,
    previous: 1,
    currentApiRevision: apiRevisionB,
    previousApiRevision: apiRevisionA,
  }), []);

  assert.deepEqual(evaluateClientVersionBump({
    current: 1,
    previous: 0,
    currentApiRevision: apiRevisionA,
    previousApiRevision: undefined,
  }), []);

  assert.match(evaluateClientVersionBump({
    current: 0,
    previous: 0,
    currentApiRevision: apiRevisionA,
    previousApiRevision: undefined,
  }).join('\n'), /strictly increase/);
});

test('reports malformed versions and gitlinks instead of passing them', () => {
  assert.match(evaluateClientVersionBump({
    current: -1,
    previous: 0,
    currentApiRevision: apiRevisionA,
    previousApiRevision: apiRevisionA,
  }).join('\n'), /HEAD client_version -1/);

  assert.match(evaluateClientVersionBump({
    current: 1,
    previous: 0,
    currentApiRevision: 'not-a-sha',
    previousApiRevision: apiRevisionA,
  }).join('\n'), /no valid 'api' gitlink/);

  assert.match(evaluateClientVersionBump({
    current: 1,
    previous: 0,
    currentApiRevision: apiRevisionA,
    previousApiRevision: 'also-not-a-sha',
  }).join('\n'), /previous revision records no valid 'api' gitlink/);
});

test('parses exactly one gitlink entry from git ls-tree output', () => {
  assert.equal(parseApiRevisionFromLsTree(`160000 commit ${apiRevisionA}\tapi\n`), apiRevisionA);
  assert.equal(parseApiRevisionFromLsTree(''), undefined);
  assert.throws(
    () => parseApiRevisionFromLsTree(`100644 blob ${apiRevisionA}\tapi\n`),
    /unreadable 'api' entry/,
  );
  assert.throws(
    () => parseApiRevisionFromLsTree(`160000 commit ${apiRevisionA}\tapi-other\n`),
    /unreadable 'api' entry/,
  );
});

// ---------------------------------------------------------------------------
// Trigger and event resolution
// ---------------------------------------------------------------------------

test('skips the base comparison only outside GitHub Actions', () => {
  assert.deepEqual(resolvePreviousRevision({}), { mode: 'local' });
  assert.deepEqual(resolvePreviousRevision({ GITHUB_ACTIONS: 'false', GITHUB_EVENT_NAME: 'push' }), { mode: 'local' });
});

test('resolves the previous revision from an explicit trigger and event', () => {
  assert.deepEqual(
    resolvePreviousRevision({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' }),
    { mode: 'revision', revision: 'origin/main' },
  );
  assert.deepEqual(
    resolvePreviousRevision({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'merge_group' }),
    { mode: 'revision', revision: 'origin/main' },
  );
  assert.deepEqual(
    resolvePreviousRevision({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch' }),
    { mode: 'no-base' },
  );
  assert.deepEqual(
    resolvePreviousRevision({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' }, { before: apiRevisionA }),
    { mode: 'revision', revision: apiRevisionA },
  );
  assert.deepEqual(
    resolvePreviousRevision({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' }, { before: zeroCommit }),
    { mode: 'first-introduction' },
  );
});

test('fails closed on an unknown trigger or a malformed push payload', () => {
  assert.throws(
    () => resolvePreviousRevision({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'schedule' }),
    /not pull_request, merge_group, push or workflow_dispatch; refusing to skip the base comparison/,
  );
  assert.throws(
    () => resolvePreviousRevision({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' }),
    /push event payload is missing or malformed/,
  );
  assert.throws(
    () => resolvePreviousRevision({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' }, {}),
    /'before' is not a full commit SHA/,
  );
  assert.throws(
    () => resolvePreviousRevision({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' }, { before: 'main' }),
    /'before' is not a full commit SHA/,
  );
});

test('reads the push event payload only from the path it is given', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-client-version-event-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = join(directory, 'event.json');

  await writeFile(eventPath, JSON.stringify({ before: apiRevisionA }), 'utf8');
  assert.deepEqual(readEventPayload({ GITHUB_EVENT_PATH: eventPath }), { before: apiRevisionA });

  await writeFile(eventPath, '{invalid', 'utf8');
  assert.throws(() => readEventPayload({ GITHUB_EVENT_PATH: eventPath }), /not valid JSON/);
  assert.throws(() => readEventPayload({}), /GITHUB_EVENT_PATH is not set/);
  assert.throws(
    () => readEventPayload({ GITHUB_EVENT_PATH: join(directory, 'missing.json') }),
    /cannot be read/,
  );
});

// ---------------------------------------------------------------------------
// Real git history
// ---------------------------------------------------------------------------

test('compares HEAD against real pull_request and push bases', async (t) => {
  const directory = await temporaryRepository(t);

  await writeVersion(directory, 1);
  setApiGitlink(directory, apiRevisionA);
  git(directory, ['add', 'client-version.json']);
  const version1 = commit(directory, 'client version 1');

  await writeVersion(directory, 2);
  git(directory, ['add', 'client-version.json']);
  const version2 = commit(directory, 'client version 2, same api gitlink');

  // The version stays at 2 while the api gitlink moves.
  setApiGitlink(directory, apiRevisionB);
  const version2MovedApi = commit(directory, 'api gitlink moved without a version bump');

  await writeVersion(directory, 1);
  git(directory, ['add', 'client-version.json']);
  const loweredVersion = commit(directory, 'client version lowered');

  git(directory, ['reset', '--hard', version2MovedApi]);
  assert.equal(readHeadClientVersion(directory), 2);

  // A pull request against the version-1 introduction: a strict increase and a
  // moved gitlink are both valid.
  git(directory, ['update-ref', 'refs/remotes/origin/main', version1]);
  const pullRequest = await runClientVersionBump({
    root: directory,
    environment: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' },
  });
  assert.equal(pullRequest.compared, true);
  assert.equal(pullRequest.current, 2);
  assert.equal(pullRequest.previous, 1);
  assert.equal(pullRequest.previousRevision, version1);
  assert.equal(pullRequest.currentApiRevision, apiRevisionB);
  assert.equal(pullRequest.previousApiRevision, apiRevisionA);
  assert.deepEqual(pullRequest.violations, []);

  // The same version over a moved gitlink is not a valid base.
  git(directory, ['update-ref', 'refs/remotes/origin/main', version2]);
  const sameVersionMovedApi = await runClientVersionBump({
    root: directory,
    environment: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' },
  });
  assert.equal(sameVersionMovedApi.previous, 2);
  assert.match(sameVersionMovedApi.violations.join('\n'), /strictly increase/);

  // A lower version is a failure even if the gitlink did not move.
  git(directory, ['reset', '--hard', loweredVersion]);
  const lowered = await runClientVersionBump({
    root: directory,
    environment: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' },
  });
  assert.match(lowered.violations.join('\n'), /decreased from 2 to 1/);

  // A push compares against the before revision named by the event payload.
  git(directory, ['reset', '--hard', version2MovedApi]);
  const eventPath = join(directory, 'push-event.json');
  await writeFile(eventPath, JSON.stringify({ before: version1 }), 'utf8');
  const push = await runClientVersionBump({
    root: directory,
    environment: {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_EVENT_PATH: eventPath,
    },
  });
  assert.equal(push.previousRevision, version1);
  assert.deepEqual(push.violations, []);

  await writeFile(eventPath, JSON.stringify({ before: version2 }), 'utf8');
  const pushedSameVersion = await runClientVersionBump({
    root: directory,
    environment: {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_EVENT_PATH: eventPath,
    },
  });
  assert.match(pushedSameVersion.violations.join('\n'), /strictly increase/);

  // An all-zero before introduces the ref: previous version 0, no previous gitlink.
  await writeFile(eventPath, JSON.stringify({ before: zeroCommit }), 'utf8');
  const introduction = await runClientVersionBump({
    root: directory,
    environment: {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_EVENT_PATH: eventPath,
    },
  });
  assert.equal(introduction.previous, 0);
  assert.equal(introduction.previousApiRevision, undefined);
  assert.deepEqual(introduction.violations, []);

  // A local run validates the current identity and skips only the comparison.
  const local = await runClientVersionBump({
    root: directory,
    environment: { GITHUB_ACTIONS: 'false' },
  });
  assert.equal(local.compared, false);
  assert.equal(local.current, 2);
  assert.deepEqual(local.violations, []);

  // Malformed payloads and unresolvable bases fail closed.
  await writeFile(eventPath, '{invalid', 'utf8');
  await assert.rejects(() => runClientVersionBump({
    root: directory,
    environment: {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_EVENT_PATH: eventPath,
    },
  }), /not valid JSON/);

  await assert.rejects(() => runClientVersionBump({
    root: directory,
    environment: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' },
  }), /GITHUB_EVENT_PATH is not set/);

  // A workflow_dispatch is an explicit build/release trigger with no base: it
  // validates the current identity and reports that nothing was compared.
  const workflowDispatch = await runClientVersionBump({
    root: directory,
    environment: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch' },
  });
  assert.equal(workflowDispatch.compared, false);
  assert.equal(workflowDispatch.reason, 'no-base');
  assert.equal(workflowDispatch.current, 2);
  assert.deepEqual(workflowDispatch.violations, []);

  await assert.rejects(() => runClientVersionBump({
    root: directory,
    environment: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'schedule' },
  }), /refusing to skip the base comparison/);

  git(directory, ['update-ref', '-d', 'refs/remotes/origin/main']);
  await assert.rejects(() => runClientVersionBump({
    root: directory,
    environment: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' },
  }), /origin\/main' cannot be resolved/);
});

test('treats a base revision without client-version.json as the first introduction', async (t) => {
  const directory = await temporaryRepository(t);

  setApiGitlink(directory, apiRevisionA);
  const introductionBase = commit(directory, 'api specification without a client version');

  await writeVersion(directory, 1);
  git(directory, ['add', 'client-version.json']);
  const head = commit(directory, 'client version 1');

  git(directory, ['update-ref', 'refs/remotes/origin/main', introductionBase]);
  const result = await runClientVersionBump({
    root: directory,
    environment: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' },
  });

  assert.equal(result.compared, true);
  assert.equal(result.previous, 0);
  assert.equal(result.previousRevision, introductionBase);
  assert.equal(result.previousApiRevision, apiRevisionA);
  assert.equal(result.current, 1);
  assert.equal(result.currentApiRevision, apiRevisionA);
  assert.deepEqual(result.violations, []);
  assert.notEqual(head, introductionBase);
});

test('fails when HEAD has no readable client-version.json', async (t) => {
  const directory = await temporaryRepository(t);

  setApiGitlink(directory, apiRevisionA);
  commit(directory, 'no client version');
  assert.throws(() => readHeadClientVersion(directory), /client-version\.json is missing or unreadable at HEAD/);
  await assert.rejects(() => runClientVersionBump({
    root: directory,
    environment: { GITHUB_ACTIONS: 'false' },
  }), /missing or unreadable at HEAD/);

  await writeFile(join(directory, 'client-version.json'), '{not json', 'utf8');
  git(directory, ['add', 'client-version.json']);
  commit(directory, 'malformed client version');
  assert.throws(() => readHeadClientVersion(directory), /client-version\.json must be valid JSON/);
});

test('runs the checker entry against the real checkout with the ambient CI environment', async () => {
  // This is the gate the test workflow itself runs: in CI the ambient trigger
  // (push, pull_request, the merge queue's merge_group or a manual
  // workflow_dispatch) drives the real checker against the real checkout;
  // locally the same call must still parse the real HEAD file and report that
  // only the base comparison was skipped.
  const root = fileURLToPath(new URL('../', import.meta.url));
  const previousExitCode = process.exitCode;
  const output = [];
  const failures = [];
  try {
    const exitCode = await main({
      root,
      environment: process.env,
      log: (message) => output.push(String(message)),
      error: (message) => failures.push(String(message)),
    });
    assert.equal(exitCode, 0, `Client version bump checker failed on the real checkout:\n${failures.join('\n')}`);
    assert.equal(process.exitCode, 0, `checker produced failures:\n${failures.join('\n')}`);

    const current = readHeadClientVersion(root);
    // The repository file is the single source of truth; the monotonic bump is
    // what this checker enforces, not a fixed value in this test.
    const declared = JSON.parse(
      readFileSync(new URL('../client-version.json', import.meta.url), 'utf8'),
    ).client_version;
    assert.equal(current, declared, 'the real HEAD client-version.json must parse');
    if (process.env.GITHUB_ACTIONS === 'true') {
      const ambientEvent = process.env.GITHUB_EVENT_NAME;
      assert.ok(
        ambientEvent === 'pull_request' || ambientEvent === 'push'
          || ambientEvent === 'workflow_dispatch' || ambientEvent === 'merge_group',
        `unexpected CI event ${String(ambientEvent)}`,
      );
      if (ambientEvent === 'workflow_dispatch') {
        // The release workflow dispatches manually: there is no base revision to
        // compare, so the ambient run must report the explicit no-base outcome.
        assert.match(output.join('\n'), /workflow_dispatch has no base revision/);
      } else {
        assert.match(output.join('\n'), /Client version bump check passed/);
      }
    } else {
      assert.match(output.join('\n'), /base comparison skipped \(local-only\)/);
      assert.match(output.join('\n'), new RegExp(`client_version ${current}:`));
    }

    // The Beta release workflow dispatches with workflow_dispatch, which has no
    // base revision: the checker must still validate the real HEAD and pass with
    // an explicit no-base report instead of failing closed.
    output.length = 0;
    failures.length = 0;
    const dispatchExitCode = await main({
      root,
      environment: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch' },
      log: (message) => output.push(String(message)),
      error: (message) => failures.push(String(message)),
    });
    assert.equal(dispatchExitCode, 0, `workflow_dispatch must validate the real checkout:\n${failures.join('\n')}`);
    assert.equal(process.exitCode, 0, `workflow_dispatch produced failures:\n${failures.join('\n')}`);
    assert.match(output.join('\n'), /workflow_dispatch has no base revision/);
    assert.match(output.join('\n'), new RegExp(`client_version ${current}:`));
  } finally {
    process.exitCode = previousExitCode;
  }
});
