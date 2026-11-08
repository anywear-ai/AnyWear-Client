// Offline scope, permission and secret tests for the Client source-CI credential
// boundary. Every case but the first is a negative: the checked-in workflows must
// pass, and each way of widening the checkout credential must be rejected with a
// message naming the file and line.
//
// Run with `pnpm run test:run`, which includes this file in its `node --test` list.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  jobPermissionSites,
  parseGitmodules,
  parseIndexGitlink,
  parseWorkflow,
  readSubmoduleRevision,
  signingSecretSites,
  signingSites,
  signingWorkflow,
  sourceCiCredentialBoundary,
  sourceCiCredentialBoundaryWith,
  specificationRepositorySlug,
  tokenSiteWith,
  tokenSites,
  validateSourceCiCredentialBoundary,
} from './source-ci-credential-boundary.mjs';

const repositoryRoot = new URL('../', import.meta.url);
const workflowsDirectory = new URL('.github/workflows/', repositoryRoot);
const gitmodulesPath = new URL('.gitmodules', repositoryRoot);
const workflowFiles = ['build.yml', 'test.yml', 'browser.yml', 'check.yml', 'client-release.yml', 'release.yml', 'tauri-smoke.yml'];
const tokenActionOf = (site) => `${sourceCiCredentialBoundary.tokenAction.repository}@${site.ref}`;

// The revision the specification checkout must pin, read from the `api` submodule's
// own checkout rather than from a literal a submodule bump can leave behind.
let cachedRevision;
async function specificationGitlink() {
  cachedRevision ??= readSubmoduleRevision(repositoryRoot, sourceCiCredentialBoundary.specificationPath);
  return cachedRevision;
}

/** The checked-in workflows, parsed fresh so one case cannot leak state into another. */
async function repositoryWorkflows() {
  const documents = [];
  for (const file of workflowFiles) {
    documents.push(parseWorkflow(await readFile(new URL(file, workflowsDirectory), 'utf8'), file));
  }
  return {
    documents,
    submoduleRepositories: parseGitmodules(await readFile(gitmodulesPath, 'utf8')),
    specificationRevision: await specificationGitlink(),
  };
}

/** Fails with the validator's own messages when a workflow leaves the boundary. */
function assertWithinBoundary(workflows) {
  assert.deepEqual(validateSourceCiCredentialBoundary(workflows), []);
}

function documentOf(documents, file) {
  const document = documents.find((candidate) => candidate.workflow.file === file);
  assert.ok(document, `expected a parsed ${file}`);
  return document;
}

function tokenStepOf(documents, file) {
  const site = tokenSites.find((candidate) => candidate.workflow === file);
  assert.ok(site, `expected a token site in ${file}`);
  const step = documentOf(documents, file).steps
    .find((candidate) => candidate.uses.startsWith('actions/create-github-app-token@') && candidate.job === site.job);
  assert.ok(step, `expected an App-token step in ${file}`);
  return step;
}

function specificationCheckoutOf(documents, file) {
  const step = documentOf(documents, file).steps.find((candidate) => candidate.uses === 'actions/checkout@v4' && candidate.with?.has('repository'));
  assert.ok(step, `expected a specification checkout in ${file}`);
  return step;
}

function clientCheckoutOf(documents, file) {
  const step = documentOf(documents, file).steps.find((candidate) => candidate.uses === 'actions/checkout@v4' && !candidate.with?.has('repository'));
  assert.ok(step, `expected a Client checkout in ${file}`);
  return step;
}

test('checked-in Client source workflows stay inside the credential boundary', async () => {
  assertWithinBoundary(await repositoryWorkflows());
});

// #278: the nine signing secrets are closed to their platform jobs in both
// `with:` and `env:`. Tauri reads its signing material through the environment,
// which was a blind spot before this change.
test('#278: the signing secrets are closed to their platform jobs and scanned in env', async () => {
  const { documents } = await repositoryWorkflows();
  const clientRelease = documentOf(documents, signingWorkflow);

  for (const [job, names] of Object.entries(signingSites)) {
    for (const name of names) {
      const reference = new RegExp(`\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`);
      const holders = [...new Set(clientRelease.steps
        .filter((step) => [...(step.env ?? new Map()).values()].some((value) => reference.test(value)))
        .map((step) => step.job))];
      assert.deepEqual(holders, [job], `${name} may be read only by ${job}`);
      assert.equal(signingSecretSites.get(name), job);
    }
  }

  // A step-level env read in the wrong job names the only allowed site.
  for (const [job, secret, expected] of [
    ['package-macos', 'WINDOWS_CERTIFICATE', /step `Setup Node` env `EXTRA` reads `secrets\.WINDOWS_CERTIFICATE`, which only `client-release\.yml:package-windows` may reference/],
    ['preflight', 'APPLE_CERTIFICATE', /step `Setup Node` env `EXTRA` reads `secrets\.APPLE_CERTIFICATE`, which only `client-release\.yml:package-macos` may reference/],
  ]) {
    const workflows = await repositoryWorkflows();
    const step = documentOf(workflows.documents, signingWorkflow).steps
      .find((candidate) => candidate.job === job && candidate.uses === 'actions/setup-node@v4');
    assert.ok(step, `expected a Setup Node step in ${job}`);
    step.env = new Map([['EXTRA', `\${{ secrets.${secret} }}`]]);
    assert.throws(() => assertWithinBoundary(workflows), expected, `expected ${secret} in ${job} to be rejected`);
  }

  // A job-level env read is inherited by every step, so it is scanned too.
  const jobEnv = await repositoryWorkflows();
  const verify = documentOf(jobEnv.documents, signingWorkflow).workflow.jobs.find((job) => job.id === 'verify');
  verify.env = new Map([['EXTRA', '${{ secrets.ANDROID_KEY_ALIAS }}']]);
  assert.throws(
    () => assertWithinBoundary(jobEnv),
    /job `verify` env `EXTRA` reads `secrets\.ANDROID_KEY_ALIAS`, which only `client-release\.yml:package-android` may reference/,
  );

  // A reference from another workflow is refused even when the job name matches a
  // signing site: the closed table names its workflow.
  const otherWorkflow = await repositoryWorkflows();
  documentOf(otherWorkflow.documents, 'release.yml').steps
    .find((step) => step.job === 'record' && step.uses === 'actions/setup-node@v4')
    .env = new Map([['EXTRA', '${{ secrets.WINDOWS_CERTIFICATE }}']]);
  assert.throws(
    () => assertWithinBoundary(otherWorkflow),
    /step `Setup Node` env `EXTRA` reads `secrets\.WINDOWS_CERTIFICATE`, which only `client-release\.yml:package-windows` may reference/,
  );
});

// #278: a job-level write permission is confined to the job that holds it. The
// pipeline has one release writer and one attestation site; a new write grant in
// any other job fails here instead of widening what a tag run can do.
test('#278: job-level write permissions are confined to their named jobs', async () => {
  for (const [file, job, permission, expected] of [
    ['client-release.yml', 'publish', ['id-token', 'write'], /job `publish` grants `id-token: write`, which only `client-release\.yml:assemble` and `release\.yml:deploy` may hold/],
    ['client-release.yml', 'assemble', ['contents', 'write'], /job `assemble` grants `contents: write`, which only `client-release\.yml:publish` may hold/],
    ['client-release.yml', 'assemble', ['artifact-metadata', 'write'], /job `assemble` grants `artifact-metadata: write`, which is not a reviewed job permission/],
    ['client-release.yml', 'verify', ['contents', 'write'], /job `verify` grants `contents: write`, which only `client-release\.yml:publish` may hold/],
    ['build.yml', 'rust-check', ['id-token', 'write'], /job `rust-check` grants `id-token: write`, which only `client-release\.yml:assemble` and `release\.yml:deploy` may hold/],
  ]) {
    const workflows = await repositoryWorkflows();
    const target = documentOf(workflows.documents, file).workflow.jobs.find((candidate) => candidate.id === job);
    assert.ok(target, `expected the ${job} job in ${file}`);
    target.permissions = new Map([...(target.permissions ?? []), permission]);
    assert.throws(
      () => assertWithinBoundary(workflows),
      expected,
      `expected ${permission.join(': ')} in ${file}:${job} to be rejected`,
    );
  }

  assert.deepEqual(Object.keys(jobPermissionSites).sort(), [
    'client-release.yml:assemble',
    'client-release.yml:publish',
    'release.yml:deploy',
  ]);
});

test('exactly two App-token steps reach exactly one repository and one permission each', async () => {
  const { documents, specificationRevision } = await repositoryWorkflows();
  const steps = documents.flatMap((document) => document.steps);
  const tokenSteps = steps.filter((step) => step.uses.startsWith('actions/create-github-app-token@'));
  const specificationCheckouts = steps.filter((step) => step.uses === 'actions/checkout@v4' && step.with?.has('repository'));

  assert.deepEqual(
    tokenSteps.map((step) => `${step.file}:${step.job}`),
    tokenSites.map((site) => `${site.workflow}:${site.job}`),
    'one credential-bearing step per token site, in the job that site names',
  );
  for (const site of tokenSites) {
    const step = tokenSteps.find((candidate) => `${candidate.file}:${candidate.job}` === `${site.workflow}:${site.job}`);
    assert.deepEqual(Object.fromEntries(step.with), tokenSiteWith(site), `${site.workflow} must pass exactly its site's inputs`);
    assert.equal(step.uses, tokenActionOf(site));
  }

  assert.equal(specificationCheckouts.length, 1);
  const checkout = specificationCheckouts[0];
  const sourceCi = tokenSites.find((site) => site.readsSpecification);
  const sourceCiToken = tokenSteps.find((step) => step.file === sourceCi.workflow);
  assert.equal(checkout.file, 'build.yml');
  assert.equal(checkout.job, sourceCi.job);
  assert.equal(checkout.with.get('repository'), specificationRepositorySlug());
  assert.equal(checkout.with.get('ref'), specificationRevision);
  assert.equal(checkout.with.get('path'), sourceCiCredentialBoundary.specificationPath);
  assert.equal(checkout.with.get('token'), `\${{ steps.${sourceCiToken.id}.outputs.token }}`);
  assert.equal(checkout.with.get('persist-credentials'), 'false');
});

test('every job that does not read the specification holds no credential', async () => {
  const { documents } = await repositoryWorkflows();
  const jobsWithToken = new Set(documents
    .flatMap((document) => document.steps)
    .filter((step) => step.uses.startsWith('actions/create-github-app-token@'))
    .map((step) => `${step.file}:${step.job}`));
  assert.deepEqual([...jobsWithToken], ['build.yml:build', 'release.yml:handoff']);
  for (const [file, job] of [
    ['build.yml', 'rust-check'],
    ['build.yml', 'tauri-desktop'],
    ['test.yml', 'test'],
    ['browser.yml', 'browser'],
    ['tauri-smoke.yml', 'tauri-smoke'],
    ['release.yml', 'build'],
    ['release.yml', 'verify'],
    ['release.yml', 'deploy'],
    ['release.yml', 'record'],
  ]) {
    const document = documentOf(documents, file);
    for (const step of document.steps.filter((candidate) => candidate.job === job)) {
      for (const value of step.with?.values() ?? []) {
        assert.doesNotMatch(value, /secrets\./, `${file}:${step.number} must not read a secret`);
      }
      assert.equal(step.with?.has('submodules') ?? false, false, `${file}:${step.number} must not fetch submodules`);
    }
  }
});

test('rejects an App-token action that is not pinned to an immutable commit', async () => {
  for (const site of tokenSites) {
    for (const uses of [
      'actions/create-github-app-token@v1',
      'actions/create-github-app-token@v2',
      'actions/create-github-app-token@v3',
      'actions/create-github-app-token@main',
      `${tokenActionOf(site)} # ${site.version}`,
      'actions/create-github-app-token@fee1f7d',
    ]) {
      const workflows = await repositoryWorkflows();
      tokenStepOf(workflows.documents, site.workflow).uses = uses;
      assert.throws(
        () => assertWithinBoundary(workflows),
        new RegExp(`App-token step must be pinned to actions/create-github-app-token@${site.ref}`),
        `expected ${uses} to be rejected in ${site.workflow}`,
      );
    }
  }
});

test('rejects an allowlist that names any repository but the one its site names', async () => {
  const cases = [
    ['build.yml', 'AnyWear-Client,AnyWear-Service-API', /requests `AnyWear-Client`; the build\.yml allowlist is exactly `AnyWear-Service-API`/],
    ['build.yml', 'anywear-ai/AnyWear-Service-API', /requests `anywear-ai\/AnyWear-Service-API`; the build\.yml allowlist is exactly `AnyWear-Service-API`/],
    ['build.yml', 'AnyWear-Service-API,AnyWear-Service', /requests `AnyWear-Service`; the build\.yml allowlist is exactly `AnyWear-Service-API`/],
    ['release.yml', 'AnyWear-Infra', /requests `AnyWear-Infra`; the release\.yml allowlist is exactly `AnyWear-E2E`/],
    ['release.yml', 'AnyWear-Service-API', /requests `AnyWear-Service-API`; the release\.yml allowlist is exactly `AnyWear-E2E`/],
  ];
  for (const [file, repositories, expected] of cases) {
    const workflows = await repositoryWorkflows();
    tokenStepOf(workflows.documents, file).with.set('repositories', repositories);
    assert.throws(() => assertWithinBoundary(workflows), expected, `expected \`repositories: ${repositories}\` to be rejected`);
  }
});

test('rejects an App-token step that drops the allowlist entirely', async () => {
  for (const site of tokenSites) {
    const workflows = await repositoryWorkflows();
    tokenStepOf(workflows.documents, site.workflow).with.delete('repositories');
    assert.throws(
      () => assertWithinBoundary(workflows),
      new RegExp(`App-token step must set \`repositories: ${site.repository}\`, found nothing`),
      `expected ${site.workflow} to keep its allowlist`,
    );
  }
});

test('rejects every permission beyond the one its site requests', async () => {
  for (const [file, key, value, expected] of [
    ['build.yml', 'permission-contents', 'write', /must request `permission-contents: read`, found `permission-contents: write`/],
    ['build.yml', 'permission-actions', 'read', /passes `permission-actions`, which is not one of the token site's boundary inputs/],
    ['build.yml', 'permission-attestations', 'read', /must request only `permission-contents`, found permission-contents, permission-attestations/],
    ['build.yml', 'permission-metadata', 'read', /must request only `permission-contents`, found permission-contents, permission-metadata/],
    ['build.yml', 'permission-pull-requests', 'write', /must request only `permission-contents`, found permission-contents, permission-pull-requests/],
    ['build.yml', 'permission-workflows', 'write', /must request only `permission-contents`, found permission-contents, permission-workflows/],
    ['release.yml', 'permission-actions', 'read', /must request `permission-actions: write`, found `permission-actions: read`/],
    ['release.yml', 'permission-contents', 'read', /must request only `permission-actions`, found permission-actions, permission-contents/],
    ['release.yml', 'permission-contents', 'write', /must request only `permission-actions`, found permission-actions, permission-contents/],
    ['release.yml', 'permission-workflows', 'write', /must request only `permission-actions`, found permission-actions, permission-workflows/],
  ]) {
    const workflows = await repositoryWorkflows();
    tokenStepOf(workflows.documents, file).with.set(key, value);
    assert.throws(() => assertWithinBoundary(workflows), expected, `expected \`${key}: ${value}\` in ${file} to be rejected`);
  }

  for (const [file, key, expected] of [
    ['build.yml', 'permission-contents', /must request only `permission-contents`, found no permission input/],
    ['release.yml', 'permission-actions', /must request only `permission-actions`, found no permission input/],
  ]) {
    const workflows = await repositoryWorkflows();
    tokenStepOf(workflows.documents, file).with.delete(key);
    assert.throws(() => assertWithinBoundary(workflows), expected, `expected ${file} without ${key} to be rejected`);
  }
});

test('rejects a substituted App ID or a secret outside the boundary on a token step', async () => {
  for (const [key, value, expected] of [
    ['app-id', '${{ secrets.APP_ID }}', /App ID must not be read from a secret, found `secrets.APP_ID`/],
    ['app-id', '${{ vars.OTHER_APP_ID }}', /App ID must come from `vars.APP_ID`, found `vars.OTHER_APP_ID`/],
    ['private-key', '${{ secrets.SOME_OTHER_TOKEN }}', /must set `private-key: \$\{\{ secrets\.APP_PRIVATE_KEY \}\}`/],
    ['skip-token-revoke', 'true', /passes `skip-token-revoke`, which is not one of the token site's boundary inputs/],
  ]) {
    for (const site of tokenSites) {
      const workflows = await repositoryWorkflows();
      tokenStepOf(workflows.documents, site.workflow).with.set(key, value);
      assert.throws(() => assertWithinBoundary(workflows), expected, `expected \`${key}: ${value}\` in ${site.workflow} to be rejected`);
    }
  }
});

test('rejects a specification checkout that widens or loses its credential', async () => {
  for (const [mutate, expected] of [
    [(step) => step.with.set('token', '${{ secrets.GITHUB_TOKEN }}'), /must use a generated App token output, found `\$\{\{ secrets\.GITHUB_TOKEN \}\}`/],
    [(step) => step.with.delete('token'), /must use a generated App token output, found `nothing`/],
    [(step) => step.with.set('token', '${{ steps.other.outputs.token }}'), /no App-token step declares that id/],
    [(step) => step.with.set('persist-credentials', 'true'), /must set `persist-credentials: false`/],
  ]) {
    const workflows = await repositoryWorkflows();
    mutate(specificationCheckoutOf(workflows.documents, 'build.yml'));
    assert.throws(() => assertWithinBoundary(workflows), expected);
  }
});

test('rejects a specification checkout that is not pinned to the recorded revision', async () => {
  const { specificationRevision } = await repositoryWorkflows();
  for (const [ref, expected] of [
    ['main', /must pin its revision by full commit, found `ref: main`/],
    [specificationRevision.slice(0, 7), new RegExp(`must pin its revision by full commit, found \`ref: ${specificationRevision.slice(0, 7)}\``)],
    ['0'.repeat(40), /pins `0{40}`, but the `api` submodule is checked out at/],
  ]) {
    const workflows = await repositoryWorkflows();
    specificationCheckoutOf(workflows.documents, 'build.yml').with.set('ref', ref);
    assert.throws(() => assertWithinBoundary(workflows), expected, `expected \`ref: ${ref}\` to be rejected`);
  }

  const workflows = await repositoryWorkflows();
  specificationCheckoutOf(workflows.documents, 'build.yml').with.delete('ref');
  assert.throws(() => assertWithinBoundary(workflows), /must pin its revision by full commit, found `ref: nothing`/);
});

test('rejects a specification checkout that drifts from the submodule it stands in for', async () => {
  // The workflow literal and the submodule pointer must agree; a bump to one alone
  // is what this catches, and neither value is a literal in this test.
  const { documents, submoduleRepositories } = await repositoryWorkflows();
  const bumped = '1'.repeat(40);
  const violations = validateSourceCiCredentialBoundary({ documents, submoduleRepositories, specificationRevision: bumped });
  assert.equal(violations.length, 1);
  assert.match(violations[0], new RegExp('build\\.yml:47 specification checkout pins `[0-9a-f]{40}`, but the `api` submodule is checked out at `1{40}`'));

  const initialized = await specificationGitlink();
  assert.match(initialized, /^[0-9a-f]{40}$/, 'the api submodule must be initialised for this suite to check the pin');
});

test('rejects a checkout that names another repository or hardcodes an owner', async () => {
  // The owner-relative expression is the only accepted form. The second entry is the
  // right repository under a hardcoded owner, which works on one side of the transfer
  // and breaks on the other, so it fails here just like a wrong repository name.
  for (const [repository, expected] of [
    ['anywear-ai/AnyWear-Service', /checkout fetches `anywear-ai\/AnyWear-Service`, which is not `\$\{\{ github\.repository_owner \}\}\/AnyWear-Service-API`/],
    ['git-malu/AnyWear-Service-API', /checkout fetches `git-malu\/AnyWear-Service-API`, which is not `\$\{\{ github\.repository_owner \}\}\/AnyWear-Service-API`/],
  ]) {
    const workflows = await repositoryWorkflows();
    specificationCheckoutOf(workflows.documents, 'build.yml').with.set('repository', repository);
    assert.throws(() => assertWithinBoundary(workflows), expected, `expected \`repository: ${repository}\` to be rejected`);
  }
});

test('rejects a specification checkout that lands somewhere other than the submodule path', async () => {
  const workflows = await repositoryWorkflows();
  specificationCheckoutOf(workflows.documents, 'build.yml').with.set('path', 'spec');
  assert.throws(() => assertWithinBoundary(workflows), /must use `path: api`, found `path: spec`/);
});

test('rejects a Client checkout that takes a credential or fetches submodules', async () => {
  for (const [mutate, expected] of [
    [(step) => step.with.set('token', '${{ steps.generate-token.outputs.token }}'), /Client checkout must use the default credential/],
    [(step) => step.with.set('submodules', 'recursive'), /Client checkout must not fetch submodules; the specification checkout reads `anywear-ai\/AnyWear-Service-API` with the App token/],
    [(step) => step.with.set('path', 'spec'), /Client checkout must not set `path`/],
  ]) {
    const workflows = await repositoryWorkflows();
    mutate(clientCheckoutOf(workflows.documents, 'build.yml'));
    assert.throws(() => assertWithinBoundary(workflows), expected);
  }

  const workflows = await repositoryWorkflows();
  const rustCheckout = documentOf(workflows.documents, 'build.yml').steps
    .find((step) => step.job === 'rust-check' && step.uses === 'actions/checkout@v4');
  rustCheckout.with.set('submodules', 'true');
  assert.throws(
    () => assertWithinBoundary(workflows),
    /build\.yml:105 the Client checkout must not fetch submodules/,
    'a job that reads no repository content must not fetch submodules under any spelling',
  );
});

test('rejects a checkout that fetches repository content by submodules rather than the boundary checkout', async () => {
  const workflows = await repositoryWorkflows();
  documentOf(workflows.documents, 'test.yml').steps
    .find((step) => step.uses === 'actions/checkout@v4')
    .with.set('submodules', 'recursive');
  assert.throws(
    () => assertWithinBoundary(workflows),
    /test\.yml:19 the Client checkout must not fetch submodules; the specification checkout reads `anywear-ai\/AnyWear-Service-API` with the App token/,
  );
});

test('rejects a caller that inherits secrets, substitutes one, or maps one the callee does not declare', async () => {
  const cases = [
    ['inherit', /check\.yml:18 job `build` must map the required secret explicitly instead of `secrets: inherit`/],
    ['substituted', /job `build` must pass `APP_PRIVATE_KEY: \$\{\{ secrets\.APP_PRIVATE_KEY \}\}`, found `APP_PRIVATE_KEY: \$\{\{ secrets.SOME_OTHER_TOKEN \}\}`/],
    ['wrong-key', /job `build` passes `OTHER_KEY`, which is outside the credential boundary/],
    ['unmapped', /job `build` does not receive `APP_PRIVATE_KEY`, but its called workflow declares it/],
    ['extra', /job `test` receives `APP_PRIVATE_KEY`, but its called workflow declares no secret/],
  ];
  for (const [variant, expected] of cases) {
    const workflows = await repositoryWorkflows();
    const callers = documentOf(workflows.documents, 'check.yml').workflow.callers;
    const build = callers.find((caller) => caller.job === 'build');
    const unitTest = callers.find((caller) => caller.job === 'test');
    if (variant === 'inherit') {
      build.secretsInherit = true;
      build.mappedSecrets = [];
    } else if (variant === 'substituted') {
      build.mappedSecrets = [{ key: 'APP_PRIVATE_KEY', value: '${{ secrets.SOME_OTHER_TOKEN }}' }];
    } else if (variant === 'wrong-key') {
      build.mappedSecrets = [{ key: 'OTHER_KEY', value: '${{ secrets.APP_PRIVATE_KEY }}' }];
    } else if (variant === 'unmapped') {
      build.mappedSecrets = [];
    } else {
      unitTest.mappedSecrets = [{ key: 'APP_PRIVATE_KEY', value: '${{ secrets.APP_PRIVATE_KEY }}' }];
    }
    assert.throws(() => assertWithinBoundary(workflows), expected, `expected the \`${variant}\` caller to be rejected`);
  }
});

test('rejects a called workflow that stops declaring the required secret', async () => {
  const optional = await repositoryWorkflows();
  documentOf(optional.documents, 'build.yml').workflow.calls = [{ name: 'APP_PRIVATE_KEY', required: 'false', number: 7 }];
  assert.throws(
    () => assertWithinBoundary(optional),
    /build\.yml:7 called workflow must declare secret `APP_PRIVATE_KEY` as `required: true`/,
  );

  const substituted = await repositoryWorkflows();
  documentOf(substituted.documents, 'build.yml').workflow.calls = [{ name: 'GITHUB_TOKEN', required: 'true', number: 7 }];
  assert.throws(
    () => assertWithinBoundary(substituted),
    /build\.yml:7 called workflow must declare only `APP_PRIVATE_KEY`, found `GITHUB_TOKEN`/,
  );

  const emptied = await repositoryWorkflows();
  documentOf(emptied.documents, 'build.yml').workflow.calls = [];
  assert.throws(
    () => assertWithinBoundary(emptied),
    /build\.yml:1 `build\.yml` must declare secret `APP_PRIVATE_KEY`/,
  );
});

test('rejects a workflow that does not declare read-only contents permission', async () => {
  for (const [grants, expected] of [
    [[], /build\.yml:9 workflow permissions must be exactly `contents: read`, found \{\}/],
    [[['contents', 'write']], /found \{"contents":"write"\}/],
    [[['contents', 'read'], ['id-token', 'write']], /found \{"contents":"read","id-token":"write"\}/],
    [[['actions', 'read']], /found \{"actions":"read"\}/],
  ]) {
    const workflows = await repositoryWorkflows();
    documentOf(workflows.documents, 'build.yml').workflow.permissions = { number: 9, grants: new Map(grants), inline: undefined };
    assert.throws(() => assertWithinBoundary(workflows), expected, `expected ${JSON.stringify(grants)} to be rejected`);
  }

  const missing = await repositoryWorkflows();
  documentOf(missing.documents, 'build.yml').workflow.permissions = null;
  assert.throws(() => assertWithinBoundary(missing), /build\.yml:1 workflow must declare `permissions: contents: read`/);

  const inline = await repositoryWorkflows();
  documentOf(inline.documents, 'build.yml').workflow.permissions = { number: 9, grants: new Map(), inline: 'read-all' };
  assert.throws(() => assertWithinBoundary(inline), /must declare `permissions: contents: read` as a mapping, found `read-all`/);
});

test('rejects a specification origin or submodule that the allowlist does not name', async () => {
  const { documents, specificationRevision } = await repositoryWorkflows();
  const renamed = validateSourceCiCredentialBoundary({
    documents,
    submoduleRepositories: new Map([['api', 'anywear-ai/AnyWear-Service']]),
    specificationRevision,
  });
  assert.match(renamed.join('\n'), /`api` points at `anywear-ai\/AnyWear-Service`, and the allowlist names `AnyWear-Service-API`/);

  const extra = validateSourceCiCredentialBoundary({
    documents,
    submoduleRepositories: new Map([['api', 'anywear-ai/AnyWear-Service-API'], ['extra', 'anywear-ai/AnyWear-E2E']]),
    specificationRevision,
  });
  assert.match(extra.join('\n'), /submodule `extra` points at `anywear-ai\/AnyWear-E2E`, which no checkout in the boundary fetches/);

  const absent = validateSourceCiCredentialBoundary({
    documents,
    submoduleRepositories: new Map(),
    specificationRevision,
  });
  assert.match(absent.join('\n'), /`\.gitmodules` declares no `api` submodule/);
});

test('rejects the boundary credential on any step but the two token sites and the specification checkout', async () => {
  for (const [file, mutate, expected] of [
    ['browser.yml', (document) => document.steps.find((step) => step.uses === 'pnpm/action-setup@v6').with.set('token', '${{ secrets.APP_PRIVATE_KEY }}'), /browser\.yml:30 step reads `secrets\.APP_PRIVATE_KEY`; only the two token sites \(build\.yml:build, release\.yml:handoff\) and the specification checkout carry that credential/],
    ['test.yml', (document) => document.steps.find((step) => step.uses === 'actions/setup-node@v4').with.set('auth-token', '${{ secrets.APP_PRIVATE_KEY }}'), /test\.yml:25 step reads `secrets\.APP_PRIVATE_KEY`; only the two token sites/],
    ['build.yml', (document) => document.steps.find((step) => step.job === 'rust-check' && step.uses === 'actions/checkout@v4').with.set('token', '${{ secrets.APP_PRIVATE_KEY }}'), /build\.yml:105/],
    ['release.yml', (document) => document.steps.find((step) => step.job === 'record' && step.uses === 'actions/upload-artifact@v4').with.set('name', '${{ secrets.APP_PRIVATE_KEY }}'), /release\.yml:\d+ step reads `secrets\.APP_PRIVATE_KEY`; only the two token sites/],
  ]) {
    const workflows = await repositoryWorkflows();
    mutate(documentOf(workflows.documents, file));
    assert.throws(() => assertWithinBoundary(workflows), expected);
  }

  const workflows = await repositoryWorkflows();
  documentOf(workflows.documents, 'test.yml').steps.find((step) => step.uses === 'actions/setup-node@v4').with.set('auth-token', '${{ secrets.SOME_OTHER }}');
  assert.throws(
    () => assertWithinBoundary(workflows),
    /test\.yml:25 step reads `secrets\.SOME_OTHER`, which is outside the credential boundary/,
  );
});

test('rejects a specification checkout that reads the secret directly or fetches submodules', async () => {
  for (const [mutate, expected] of [
    [(step) => step.with.set('extra-token', '${{ secrets.APP_PRIVATE_KEY }}'), /build\.yml:47 specification checkout reads `secrets\.APP_PRIVATE_KEY` directly/],
    [(step) => step.with.set('submodules', 'recursive'), /build\.yml:47 specification checkout must not fetch submodules; found `submodules: recursive`/],
  ]) {
    const workflows = await repositoryWorkflows();
    mutate(specificationCheckoutOf(workflows.documents, 'build.yml'));
    assert.throws(() => assertWithinBoundary(workflows), expected);
  }
});

test('fails closed when the credential surface is emptied or a call resolves elsewhere', async () => {
  const emptied = await repositoryWorkflows();
  for (const document of emptied.documents) document.steps = [];
  assert.throws(
    () => assertWithinBoundary(emptied),
    /no App-token step was found; the boundary is unverified/,
    'removing the token steps must not silently satisfy a suite that matches nothing',
  );

  const moved = await repositoryWorkflows();
  const caller = documentOf(moved.documents, 'check.yml').workflow.callers.find((candidate) => candidate.job === 'build');
  caller.uses = 'uses: ./.github/workflows/browser.yml';
  assert.throws(
    () => assertWithinBoundary(moved),
    /the credential-bearing workflow is `build\.yml`, and job `build` resolves to `browser\.yml`/,
  );
});

test('the boundary names the two token sites, each one repository and one permission', async () => {
  const submoduleRepositories = parseGitmodules(await readFile(gitmodulesPath, 'utf8'));
  assert.deepEqual([...submoduleRepositories], [['api', 'anywear-ai/AnyWear-Service-API']]);
  assert.equal(sourceCiCredentialBoundary.specificationRepository, 'AnyWear-Service-API');
  assert.equal(sourceCiCredentialBoundary.specificationPath, 'api');
  // The checkout names the owner-relative form; a named owner still resolves the
  // same repository, which is what `.gitmodules` records.
  assert.equal(specificationRepositorySlug(), '${{ github.repository_owner }}/AnyWear-Service-API');
  assert.equal(specificationRepositorySlug('anywear-ai'), 'anywear-ai/AnyWear-Service-API');
  assert.deepEqual(sourceCiCredentialBoundaryWith, {
    'app-id': '${{ vars.APP_ID }}',
    'private-key': '${{ secrets.APP_PRIVATE_KEY }}',
    owner: '${{ github.repository_owner }}',
    repositories: 'AnyWear-Service-API',
    'permission-contents': 'read',
  });
  assert.deepEqual(tokenSites, [
    {
      workflow: 'build.yml',
      job: 'build',
      ref: 'fee1f7d63c2ff003460e3d139729b119787bc349',
      version: 'v2.2.2',
      repository: 'AnyWear-Service-API',
      permissions: { contents: 'read' },
      readsSpecification: true,
    },
    {
      workflow: 'release.yml',
      job: 'handoff',
      ref: '64ab729a6294000f5aa4a4bc0b73d1f32bc45510',
      version: 'v3.3.0',
      repository: 'AnyWear-E2E',
      permissions: { actions: 'write' },
      readsSpecification: false,
    },
  ]);
  assert.deepEqual(tokenSites.map(tokenSiteWith), [
    {
      'app-id': '${{ vars.APP_ID }}',
      'private-key': '${{ secrets.APP_PRIVATE_KEY }}',
      owner: '${{ github.repository_owner }}',
      repositories: 'AnyWear-Service-API',
      'permission-contents': 'read',
    },
    {
      'app-id': '${{ vars.APP_ID }}',
      'private-key': '${{ secrets.APP_PRIVATE_KEY }}',
      owner: '${{ github.repository_owner }}',
      repositories: 'AnyWear-E2E',
      'permission-actions': 'write',
    },
  ]);
});

test('the Client publication path adds one token, in handoff, and its checkouts keep the default credential', async () => {
  const { documents } = await repositoryWorkflows();
  const publisher = documentOf(documents, 'release.yml');
  const tokenSteps = publisher.steps.filter((step) => step.uses.startsWith('actions/create-github-app-token@'));
  assert.equal(tokenSteps.length, 1);
  assert.equal(`${tokenSteps[0].file}:${tokenSteps[0].job}`, 'release.yml:handoff');
  assert.deepEqual(publisher.steps.filter((step) => step.with?.has('submodules')), []);
  assert.deepEqual(publisher.workflow.calls, []);
  const checkouts = publisher.steps.filter((step) => step.uses === 'actions/checkout@v4');
  assert.ok(checkouts.length > 0, 'the publication chain still checks the Client out');
  for (const checkout of checkouts) {
    assert.equal(checkout.with.has('token'), false);
    assert.equal(checkout.with.has('repository'), false);
  }
});

test('a token step outside the two sites is rejected, so no other job can mint one', async () => {
  // The dispatch and the record jobs are the dangerous ones: either could start an
  // E2E run or edit a release if it minted a token of its own.
  for (const [file, job] of [['release.yml', 'record'], ['release.yml', 'deploy'], ['build.yml', 'rust-check'], ['check.yml', 'test']]) {
    const workflows = await repositoryWorkflows();
    const document = documentOf(workflows.documents, file);
    document.steps.push({
      file,
      number: 999,
      job,
      name: 'Extra token',
      id: 'extra',
      uses: tokenActionOf(tokenSites[0]),
      with: new Map(Object.entries(tokenSiteWith(tokenSites[0]))),
    });
    assert.throws(
      () => assertWithinBoundary(workflows),
      new RegExp(`App-token step is in \`${file}:${job}\`, which is not one of the two token sites`),
      `expected a token in ${file}:${job} to be rejected`,
    );
  }

  // Removing one of the two sites must fail, not quietly narrow the boundary.
  const workflows = await repositoryWorkflows();
  const release = documentOf(workflows.documents, 'release.yml');
  release.steps = release.steps.filter((step) => step.job !== 'handoff');
  assert.throws(
    () => assertWithinBoundary(workflows),
    /no App-token step was found in `release\.yml:handoff`; the release\.yml token site is unverified/,
  );
});

test('the pinned App-token action accepts every input each token site passes', async (t) => {
  // The action's own metadata and bundled implementation at each pinned commit are
  // the authority for what it accepts. This reaches the network; without it the
  // other cases still cover the boundaries the workflows must stay inside.
  const pinned = sourceCiCredentialBoundary.tokenAction;
  const source = async (ref, path) => {
    const response = await fetch(`https://raw.githubusercontent.com/${pinned.repository}/${ref}/${path}`, {
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(response.status, 200, `${pinned.repository}@${ref}/${path} must be readable`);
    return response.text();
  };

  const metadata = new Map();
  try {
    for (const site of tokenSites) metadata.set(site.workflow, await source(site.ref, 'action.yml'));
  } catch (error) {
    t.diagnostic(`Pinned action metadata was not reachable: ${error.message}`);
    return;
  }

  // Every input each site passes must be an input that site's pin declares, and the
  // permission the site asks for must be one the action can request.
  for (const site of tokenSites) {
    const action = metadata.get(site.workflow);
    for (const key of Object.keys(tokenSiteWith(site))) {
      assert.match(action, new RegExp(`^\\s{2}${key}:$`, 'm'), `action.yml@${site.version} must declare input \`${key}\`, which ${site.workflow} passes`);
    }
    for (const name of Object.keys(site.permissions)) {
      assert.match(action, new RegExp(`^\\s{2}permission-${name}:$`, 'm'), `action.yml@${site.version} must declare \`permission-${name}\``);
    }
  }

  const sourceCi = tokenSites[0];
  assert.match(
    metadata.get(sourceCi.workflow),
    /^\s{2}permission-contents:\n(?:\s+.*\n)*?\s+description: "[^"]*'read' or 'write'\."/m,
    'the source-CI pin must keep declaring `permission-contents` as a read/write level',
  );

  // Runtime behaviour at the source-CI pin: the allowlist is applied to the named
  // owner, and the requested permission set is exactly what the workflow asks for.
  let implementation;
  try {
    implementation = await source(sourceCi.ref, 'dist/main.cjs');
  } catch (error) {
    t.diagnostic(`Pinned action implementation was not reachable: ${error.message}`);
    return;
  }

  assert.ok(implementation.includes("Inputs 'owner' and 'repositories' are set. Creating token for the following repositories"));
  assert.ok(implementation.includes('"GET /repos/{owner}/{repo}/installation"'));
  assert.ok(implementation.includes('"POST /app/installations/{installation_id}/access_tokens"'));
  assert.ok(implementation.includes('var repositories = getInput("repositories").split(/[\\n,]+/).map((s) => s.trim())'));
  assert.ok(implementation.includes('repositoryNames: parsedRepositoryNames,\n    permissions: permissions2'));

  // The v3 line deprecates `app-id` for `client-id`, so the source-CI pin stays inside
  // v2, whose declared inputs the specification checkout is written against. The
  // release handoff uses the v3 line and passes `app-id`, which that pin still
  // declares and accepts.
  assert.equal(sourceCi.version, 'v2.2.2');
  assert.equal(tokenSites[1].version, 'v3.3.0');
});

test('the submodule revision comes from the index gitlink, not a literal', async () => {
  const gitlink = await specificationGitlink();
  assert.match(gitlink, /^[0-9a-f]{40}$/);
  assert.equal(await readSubmoduleRevision(repositoryRoot, sourceCiCredentialBoundary.specificationPath), gitlink);

  // The reader must refuse anything that is not the gitlink it is looking for, rather
  // than answering with something that looks like a revision.
  assert.throws(
    () => parseIndexGitlink(Buffer.from('nope'), 'api'),
    /The git index does not start with DIRC/,
  );
  const index = await readIndexFileForTest();
  assert.equal(parseIndexGitlink(index, sourceCiCredentialBoundary.specificationPath), gitlink);
  assert.throws(() => parseIndexGitlink(index, 'not-a-path'), /The git index records no `not-a-path` entry/);
  assert.throws(
    () => parseIndexGitlink(index, '.gitmodules'),
    /Index entry `\.gitmodules` is mode 100644, not a gitlink/,
    'a tracked file at the same path must not be read as a revision',
  );
});

/** The repository's git index, located the same way for a clone and a worktree. */
async function readIndexFileForTest() {
  const entryPath = new URL('.git', repositoryRoot);
  const entry = await readFile(entryPath, 'utf8').catch(() => undefined);
  if (entry === undefined) return readFile(new URL('.git/index', repositoryRoot));
  const gitDirectory = /^gitdir:\s*(.+)$/m.exec(entry)?.[1]?.trim();
  return readFile(new URL('index', pathToFileURL(`${resolve(fileURLToPath(repositoryRoot), gitDirectory)}${sep}`)));
}

test('an unreadable workflow or .gitmodules is reported instead of passing silently', async () => {
  assert.throws(
    () => parseWorkflow('name: X\nfoo: bar\n', 'broken.yml'),
    /Unsupported top-level workflow key on line 2: foo/,
    'an unknown top-level key means the file was not read as expected',
  );
  assert.throws(
    () => parseWorkflow('name: X\njobs:\n  build:\n    steps:\n      - run\n', 'broken.yml'),
    /Unsupported workflow syntax on line 5: run/,
    'a step that is not `- key: value` must not be read as a boundary-shaped file',
  );
  assert.throws(
    () => parseWorkflow('name: X\njobs:\n  build:\n    steps:\n      with: x\n', 'broken.yml'),
    /Expected a workflow step on line 5: with: x/,
    'a steps block that is not a sequence must not be read as steps',
  );
  assert.throws(
    () => parseGitmodules('[submodule "api"]\n\turl = https://github.com/anywear-ai/AnyWear-Service-API.git\n'),
    /declares a url before its path/,
  );
  assert.throws(
    () => parseGitmodules('[submodule "api"]\n\tpath = api\n\turl = git@gitlab.com:anywear-ai/AnyWear-Service-API.git\n'),
    /url is not a GitHub repository/,
  );
  assert.throws(
    () => parseGitmodules('[submodule "api"]\n\tpath = api\n'),
    /declares path 'api' without a url/,
  );
});

// #294: the four credential-boundary claims in `client-release.yml:19-23` are
// asserted in source now: no job-level `environment:`, no cloud-credential action
// or job-level `uses:`, no role-shaped `vars.` or `arn:aws:` value, and no cloud CLI
// in a `run:` body.
//
// Every packaging-entry fixture splices text into the checked-in `client-release.yml`
// and re-parses it. A fixture that mutates a parsed object proves the validator only;
// a spliced fixture proves the parser too, which is where the evasions live.

/** The 1-based line number of the first occurrence of `needle` in `text`. */
function lineOf(text, needle) {
  const index = text.indexOf(needle);
  assert.ok(index >= 0, `expected the fixture to contain ${needle}`);
  return text.slice(0, index).split('\n').length;
}

/** Replace the first occurrence of `needle`, keeping `$` sequences literal. */
function spliceFirst(text, needle, replacement) {
  const index = text.indexOf(needle);
  assert.ok(index >= 0, `expected the fixture to contain ${needle}`);
  return `${text.slice(0, index)}${replacement}${text.slice(index + needle.length)}`;
}

/** Insert `addition` directly after the first occurrence of `needle`. */
function insertAfter(text, needle, addition) {
  return spliceFirst(text, needle, `${needle}${addition}`);
}

/** The live workflows with `client-release.yml` replaced by the spliced text, re-parsed. */
async function splicedSigningWorkflow(splice) {
  const workflows = await repositoryWorkflows();
  const text = await readFile(new URL(signingWorkflow, workflowsDirectory), 'utf8');
  const spliced = splice(text);
  assert.notEqual(spliced, text, 'the fixture must change the checked-in workflow text');
  const index = workflows.documents.findIndex((document) => document.workflow.file === signingWorkflow);
  assert.ok(index >= 0, `expected a parsed ${signingWorkflow}`);
  workflows.documents[index] = parseWorkflow(spliced, signingWorkflow);
  return { workflows, text: spliced };
}

// `client-release.yml` holds no `vars.` reference at all, so the negative fixtures
// below and the index forms are the only discriminating cases for the matcher; do
// not delete them as redundant.
const roleVariable = '${{ vars.CLIENT_PUBLISH_ROLE_ARN }}';

/** Splice `EXTRA: <expression>` into the workflow-level `env:` block. */
function withWorkflowEnv(expression) {
  return (text) => spliceFirst(
    text,
    'env:\n  BETA_API_BASE_URL:',
    `env:\n  EXTRA: ${expression}\n  BETA_API_BASE_URL:`,
  );
}

/** Splice one step before the first `- name: Checkout` of `preflight`. */
function withPreflightStep(step) {
  return (text) => spliceFirst(
    text,
    '    steps:\n      - name: Checkout\n',
    `    steps:\n${step}\n\n      - name: Checkout\n`,
  );
}

test('#294: a job-level environment in the packaging entry is rejected', async () => {
  const inline = await splicedSigningWorkflow((text) => insertAfter(
    text,
    '    name: Preflight the release tag\n',
    '    environment: beta\n',
  ));
  assert.deepEqual(validateSourceCiCredentialBoundary(inline.workflows), [
    `client-release.yml:${lineOf(inline.text, '    environment: beta')} job \`preflight\` declares \`environment: beta\`; the packaging entry holds no GitHub Environment, so no job may declare one — the Client workflow census is authoritative in pipeline_stages.md § Protected entry points`,
  ]);

  const block = await splicedSigningWorkflow((text) => insertAfter(
    text,
    '    name: Preflight the release tag\n',
    '    environment:\n      name: beta\n',
  ));
  assert.deepEqual(validateSourceCiCredentialBoundary(block.workflows), [
    `client-release.yml:${lineOf(block.text, '    environment:')} job \`preflight\` declares \`environment:\`; the packaging entry holds no GitHub Environment, so no job may declare one — the Client workflow census is authoritative in pipeline_stages.md § Protected entry points`,
  ]);
});

test('#294: a cloud-credential action or input in the packaging entry is rejected', async () => {
  for (const [step, expectedUse, vendor] of [
    [
      '      - name: Cloud credentials\n        uses: aws-actions/configure-aws-credentials@v4',
      'aws-actions/configure-aws-credentials@v4',
      'AWS',
    ],
    [
      '      - name: Cloud credentials\n        uses: AWS-Actions/Configure-AWS-Credentials@v4',
      'AWS-Actions/Configure-AWS-Credentials@v4',
      'AWS',
    ],
    [
      '      - name: Cloud credentials\n        uses: azure/trusted-signing-action@v1',
      'azure/trusted-signing-action@v1',
      'Azure',
    ],
  ]) {
    const { workflows, text } = await splicedSigningWorkflow(withPreflightStep(step));
    assert.deepEqual(validateSourceCiCredentialBoundary(workflows), [
      `client-release.yml:${lineOf(text, '      - name: Cloud credentials')} step \`Cloud credentials\` uses \`${expectedUse}\`, a cloud-credential action (${vendor}); the packaging entry holds no cloud principal — adopting a cloud signing mechanism amends ADR-0036 §5 and the guard's signing table in the same delivery`,
    ]);
  }

  // An unknown vendor is caught by the input it passes, because the guard cannot
  // attribute the action name.
  const unknownVendor = await splicedSigningWorkflow(withPreflightStep([
    '      - name: Unknown vendor signer',
    '        uses: example/sign@v1',
    '        with:',
    '          role-to-assume: placeholder',
  ].join('\n')));
  assert.deepEqual(validateSourceCiCredentialBoundary(unknownVendor.workflows), [
    `client-release.yml:${lineOf(unknownVendor.text, '      - name: Unknown vendor signer')} step \`Unknown vendor signer\` passes \`with: role-to-assume\`, a cloud-credential input; the packaging entry holds no cloud credential — adopting a cloud signing mechanism amends ADR-0036 §5 and the guard's signing table in the same delivery`,
  ]);
});

test('#294: a role-shaped vars reference or an arn:aws value in the packaging entry is rejected', async () => {
  const workflowEnv = await splicedSigningWorkflow(withWorkflowEnv(roleVariable));
  assert.deepEqual(validateSourceCiCredentialBoundary(workflowEnv.workflows), [
    `client-release.yml:${lineOf(workflowEnv.text, 'env:\n  EXTRA:')} workflow env \`EXTRA\` reads \`vars.CLIENT_PUBLISH_ROLE_ARN\`, a role-shaped variable; the packaging entry names no cloud role`,
  ]);

  const jobEnv = await splicedSigningWorkflow((text) => insertAfter(
    text,
    '    name: Preflight the release tag\n',
    `    env:\n      EXTRA: ${roleVariable}\n`,
  ));
  assert.deepEqual(validateSourceCiCredentialBoundary(jobEnv.workflows), [
    `client-release.yml:${lineOf(jobEnv.text, '    env:\n      EXTRA:')} job \`preflight\` env \`EXTRA\` reads \`vars.CLIENT_PUBLISH_ROLE_ARN\`, a role-shaped variable; the packaging entry names no cloud role`,
  ]);

  const stepEnv = await splicedSigningWorkflow((text) => insertAfter(
    text,
    '          TAG: ${{ github.ref_name }}\n',
    `          EXTRA: ${roleVariable}\n`,
  ));
  assert.deepEqual(validateSourceCiCredentialBoundary(stepEnv.workflows), [
    `client-release.yml:${lineOf(stepEnv.text, '      - name: Validate the tag and resolve the declared platforms')} step \`Validate the tag and resolve the declared platforms\` env \`EXTRA\` reads \`vars.CLIENT_PUBLISH_ROLE_ARN\`, a role-shaped variable; the packaging entry names no cloud role`,
  ]);

  for (const [expression, reference] of [
    ["${{ vars['CLIENT_PUBLISH_ROLE_ARN'] }}", "vars['CLIENT_PUBLISH_ROLE_ARN']"],
    ['${{ vars["CLIENT_PUBLISH_ROLE_ARN"] }}', 'vars["CLIENT_PUBLISH_ROLE_ARN"]'],
    ['${{ vars.AWS_ROLE_ARN }}', 'vars.AWS_ROLE_ARN'],
    ['${{ vars.SIGNING_ROLE }}', 'vars.SIGNING_ROLE'],
  ]) {
    const { workflows, text } = await splicedSigningWorkflow(withWorkflowEnv(expression));
    assert.deepEqual(validateSourceCiCredentialBoundary(workflows), [
      `client-release.yml:${lineOf(text, 'env:\n  EXTRA:')} workflow env \`EXTRA\` reads \`${reference}\`, a role-shaped variable; the packaging entry names no cloud role`,
    ]);
  }

  const arn = await splicedSigningWorkflow((text) => spliceFirst(
    text,
    'env:\n  BETA_API_BASE_URL:',
    "env:\n  ROLE_ARN: 'arn:aws:iam::123456789012:role/deploy'\n  BETA_API_BASE_URL:",
  ));
  assert.deepEqual(validateSourceCiCredentialBoundary(arn.workflows), [
    `client-release.yml:${lineOf(arn.text, 'env:\n  ROLE_ARN:')} workflow env \`ROLE_ARN\` names \`arn:aws:iam::123456789012:role/deploy\`; the packaging entry names no cloud principal`,
  ]);

  const computedIndex = await splicedSigningWorkflow(withWorkflowEnv('${{ vars[matrix.secret_name] }}'));
  assert.deepEqual(validateSourceCiCredentialBoundary(computedIndex.workflows), [
    `client-release.yml:${lineOf(computedIndex.text, 'env:\n  EXTRA:')} workflow env \`EXTRA\` reads \`vars[matrix.secret_name]\`, whose name cannot be resolved; the packaging entry names no computed cloud reference`,
  ]);

  // `ROLE`/`ARN` only count as a whole segment, and `LEARNING_MODE` contains neither.
  for (const negative of ['${{ vars.LEARNING_MODE }}', '${{ vars.AWS_REGION }}', '${{ vars.AWS_ACCOUNT_ID }}']) {
    const { workflows } = await splicedSigningWorkflow(withWorkflowEnv(negative));
    assert.deepEqual(validateSourceCiCredentialBoundary(workflows), []);
  }
});

test('#294: a cloud CLI in a run: body of the packaging entry is rejected', async () => {
  for (const [scalar, body] of [
    ['|', '          aws sts get-caller-identity'],
    ['>', '          sudo aws s3 cp dist/x s3://bucket/x'],
    ['|', '          pnpm exec aws s3 ls'],
  ]) {
    const { workflows, text } = await splicedSigningWorkflow(withPreflightStep([
      '      - name: Cloud probe',
      `        run: ${scalar}`,
      body,
    ].join('\n')));
    assert.deepEqual(validateSourceCiCredentialBoundary(workflows), [
      `client-release.yml:${lineOf(text, body)} step \`Cloud probe\` runs \`aws\` in its \`run:\` body; the packaging entry runs no cloud CLI`,
    ]);
  }
});

test('#294: a job-level uses in the packaging entry is rejected, stricter than requirement 13', async () => {
  // A job-level `uses:` is a reusable-workflow reference, never a cloud-credential
  // action, so requirement 13's literal clause does not name it. It is refused
  // anyway, and deliberately: a called workflow's steps are outside everything the
  // four assertions can read, so the boundary cannot verify what the call runs.
  //
  // The fixture calls `test.yml`, a reviewed workflow file, so the existing caller
  // rule stays silent. A call to an unreviewed file would fire that rule's "not one
  // of the workflow files under review" message, and the test would prove the old
  // rule instead of this one.
  const { workflows, text } = await splicedSigningWorkflow((source) => spliceFirst(
    source,
    'jobs:\n',
    'jobs:\n  called:\n    uses: ./.github/workflows/test.yml\n\n',
  ));
  assert.deepEqual(validateSourceCiCredentialBoundary(workflows), [
    `client-release.yml:${lineOf(text, '    uses: ./.github/workflows/test.yml')} job \`called\` calls \`./.github/workflows/test.yml\`; the packaging entry inlines its steps so the boundary can read them`,
  ]);
});

test('#294: the parser fails closed on a job shape it cannot read', async () => {
  const text = await readFile(new URL(signingWorkflow, workflowsDirectory), 'utf8');
  for (const [addition, expected] of [
    [
      '  cloud: &cloud\n    runs-on: ubuntu-latest\n    environment: beta',
      /Unsupported workflow job on line \d+: `cloud` declares neither `steps:` nor `uses:`/,
    ],
    [
      '  cloudflow: {runs-on: ubuntu-latest, environment: beta, steps: [{run: aws sts get-caller-identity}]}',
      /Unsupported workflow job on line \d+: `cloudflow` declares neither `steps:` nor `uses:`/,
    ],
    [
      '  <<: *cloud',
      /Unsupported workflow syntax on line \d+: <<: \*cloud/,
    ],
  ]) {
    const spliced = spliceFirst(text, 'jobs:\n', `jobs:\n${addition}\n`);
    assert.notEqual(spliced, text, 'the fixture must change the checked-in workflow text');
    assert.throws(() => parseWorkflow(spliced, signingWorkflow), expected);
  }
});

test('#294: the packaging-entry boundary is silent on the live workflow and fails closed without it', async () => {
  assert.deepEqual(validateSourceCiCredentialBoundary(await repositoryWorkflows()), []);

  const workflows = await repositoryWorkflows();
  workflows.documents = workflows.documents.filter((document) => document.workflow.file !== signingWorkflow);
  assert.deepEqual(validateSourceCiCredentialBoundary(workflows), [
    'client-release.yml:1 `client-release.yml` was not parsed; the packaging-entry boundary is unverified',
  ]);
});

test('#294: the packaging-entry assertions are keyed to client-release.yml, not every workflow', async () => {
  assert.deepEqual(validateSourceCiCredentialBoundary(await repositoryWorkflows()), []);

  // The confinement is the rule: `release.yml` is the web-publication entry and
  // legitimately assumes its own AWS role. The proof is only worth making while the
  // publisher still holds every construct the four assertions reject.
  const publisherText = await readFile(new URL('release.yml', workflowsDirectory), 'utf8');
  for (const needle of [
    'environment: beta',
    'uses: aws-actions/configure-aws-credentials@v4',
    'role-to-assume: ${{ vars.CLIENT_PUBLISH_ROLE_ARN }}',
    'aws sts get-caller-identity',
    'arn:aws:sts::',
    'aws s3 sync',
  ]) {
    assert.ok(publisherText.includes(needle), `the scoping proof needs release.yml to still contain ${needle}`);
  }

  // Parsed under the packaging entry's file name, `release.yml` is exactly nine
  // packaging-entry violations: one environment, one cloud-credential action, four
  // role-shaped references, one ARN and two cloud CLI invocations. Other validator
  // rules also fire on this renamed document, so the packaging-entry messages are
  // filtered out by family first; the total pins the else-if rule too, because a
  // `with:` finding on the known AWS action would make it ten.
  const renamed = parseWorkflow(publisherText, signingWorkflow);
  const violations = validateSourceCiCredentialBoundary({
    documents: [renamed],
    submoduleRepositories: parseGitmodules(await readFile(gitmodulesPath, 'utf8')),
    specificationRevision: await specificationGitlink(),
  });
  const packaging = violations.filter((message) => /declares `environment: |a cloud-credential action \(|passes `with: .*, a cloud-credential input|a role-shaped variable|whose name cannot be resolved|names `arn:aws|runs `[a-z]+` in its `run:` body/.test(message));
  assert.equal(packaging.length, 9);
  const families = (needle) => packaging.filter((message) => message.includes(needle));
  assert.equal(families('declares `environment: beta`').length, 1);
  assert.match(families('declares `environment: beta`')[0], /job `deploy` declares `environment: beta`/);
  assert.equal(families('a cloud-credential action (AWS)').length, 1);
  assert.match(families('a cloud-credential action (AWS)')[0], /uses `aws-actions\/configure-aws-credentials@v4`, a cloud-credential action \(AWS\)/);
  assert.equal(families('reads `vars.CLIENT_PUBLISH_ROLE_ARN`, a role-shaped variable').length, 4);
  assert.equal(families('names `arn:aws:sts::').length, 1);
  assert.equal(families('runs `aws` in its `run:` body').length, 2);
});

test('#294: the guard signing names match the env-scope allowlist', async () => {
  // Read as text, not imported: a test that imports its subject verifies nothing,
  // and the env-scope file is a test file, not a module this suite may execute.
  const envScopeText = await readFile(new URL('env-scope.node-test.mjs', import.meta.url), 'utf8');
  const secretsBlock = /^ {2}secrets: \[\n([\s\S]*?)^ {2}\],/m.exec(envScopeText)?.[1];
  assert.ok(secretsBlock, 'env-scope.node-test.mjs must declare REPOSITORY_SCOPED.secrets as a list');
  const envScopeSecrets = [...secretsBlock.matchAll(/^ {4}'([A-Z0-9_]+)',$/gm)].map((match) => match[1]);
  assert.deepEqual([...Object.values(signingSites).flat()].sort(), envScopeSecrets.filter((name) => name !== 'APP_PRIVATE_KEY').sort());
  assert.equal(Object.values(signingSites).flat().length, 9);
  assert.match(envScopeText, /^const ENVIRONMENT_SCOPED = \[\];$/m);
});
