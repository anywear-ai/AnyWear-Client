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
  credentialBoundaryJob,
  credentialBoundaryWorkflows,
  jobPermissionSites,
  parseGitmodules,
  parseIndexGitlink,
  parseWorkflow,
  readSubmoduleRevision,
  signingSecretSites,
  signingSites,
  signingWorkflows,
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
const workflowFiles = ['build.yml', 'test.yml', 'browser.yml', 'check.yml', 'client-beta-apk.yml', 'client-release.yml', 'release.yml', 'tauri-smoke.yml'];
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

// #278/#322: the nine signing secrets are closed to their `workflow:job` sites in
// both `with:` and `env:`. Tauri reads its signing material through the environment,
// which was a blind spot before #278, and the four `ANDROID_*` secrets are admitted
// at exactly two sites because the merge Beta path packages Android too.
test('#278: the signing secrets are closed to their named sites and scanned in env', async () => {
  const { documents } = await repositoryWorkflows();
  const reference = /^\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}$/;

  // Every referencing `workflow:job` site, read from the parsed steps' env maps.
  const holders = new Map();
  for (const document of documents) {
    for (const step of document.steps) {
      for (const value of (step.env ?? new Map()).values()) {
        const name = reference.exec(value)?.[1];
        if (name === undefined || !signingSecretSites.has(name)) continue;
        const site = `${document.workflow.file}:${step.job}`;
        if (!holders.has(name)) holders.set(name, new Set());
        holders.get(name).add(site);
      }
    }
  }

  for (const [name, sites] of signingSecretSites) {
    assert.deepEqual(
      [...(holders.get(name) ?? [])].sort(),
      [...sites].sort(),
      `${name} may be read only at its closed sites`,
    );
  }
  for (const secret of ['ANDROID_KEY_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD']) {
    assert.deepEqual(
      [...signingSecretSites.get(secret)].sort(),
      ['client-beta-apk.yml:package-beta-apk', 'client-release.yml:package-android'],
      `${secret} is admitted at exactly the two Android packaging sites`,
    );
    assert.ok(holders.get(secret)?.has('client-beta-apk.yml:package-beta-apk'), `${secret} is read by the Beta packaging job`);
  }
  for (const secret of ['WINDOWS_CERTIFICATE', 'WINDOWS_CERTIFICATE_PASSWORD', 'APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_API_KEY_P8']) {
    assert.equal(signingSecretSites.get(secret).size, 1, `${secret} stays closed to one platform site`);
  }

  // A step-level env read in the wrong job names the only allowed site.
  for (const [job, secret, expected] of [
    ['package-macos', 'WINDOWS_CERTIFICATE', /step `Setup Node` env `EXTRA` reads `secrets\.WINDOWS_CERTIFICATE`, which only `client-release\.yml:package-windows` may reference; signing is isolated per site/],
    ['preflight', 'APPLE_CERTIFICATE', /step `Setup Node` env `EXTRA` reads `secrets\.APPLE_CERTIFICATE`, which only `client-release\.yml:package-macos` may reference; signing is isolated per site/],
  ]) {
    const workflows = await repositoryWorkflows();
    const step = documentOf(workflows.documents, signingWorkflows[0]).steps
      .find((candidate) => candidate.job === job && candidate.uses === 'actions/setup-node@v4');
    assert.ok(step, `expected a Setup Node step in ${job}`);
    step.env = new Map([['EXTRA', `\${{ secrets.${secret} }}`]]);
    assert.throws(() => assertWithinBoundary(workflows), expected, `expected ${secret} in ${job} to be rejected`);
  }

  // The four Android secrets name both admitted sites in the refusal, and a
  // reference from the Beta workflow's publish job fails even though the secret is
  // admitted in the same file.
  const jobEnv = await repositoryWorkflows();
  const verify = documentOf(jobEnv.documents, signingWorkflows[0]).workflow.jobs.find((job) => job.id === 'verify');
  verify.env = new Map([['EXTRA', '${{ secrets.ANDROID_KEY_ALIAS }}']]);
  assert.throws(
    () => assertWithinBoundary(jobEnv),
    /job `verify` env `EXTRA` reads `secrets\.ANDROID_KEY_ALIAS`, which only `client-beta-apk\.yml:package-beta-apk` and `client-release\.yml:package-android` may reference; signing is isolated per site/,
  );

  const wrongJob = await repositoryWorkflows();
  documentOf(wrongJob.documents, 'client-beta-apk.yml').steps
    .find((step) => step.job === 'publish-beta-prerelease')
    .env = new Map([['EXTRA', '${{ secrets.ANDROID_KEY_ALIAS }}']]);
  assert.throws(
    () => assertWithinBoundary(wrongJob),
    /step `Download this run's Beta APK` env `EXTRA` reads `secrets\.ANDROID_KEY_ALIAS`, which only `client-beta-apk\.yml:package-beta-apk` and `client-release\.yml:package-android` may reference; signing is isolated per site/,
  );

  // A job-level env read is inherited by every step, so it is scanned too.
  const inherited = await repositoryWorkflows();
  const verifyJob = documentOf(inherited.documents, signingWorkflows[0]).workflow.jobs.find((job) => job.id === 'verify');
  verifyJob.env = new Map([['EXTRA', '${{ secrets.ANDROID_KEYSTORE_PASSWORD }}']]);
  assert.throws(
    () => assertWithinBoundary(inherited),
    /job `verify` env `EXTRA` reads `secrets\.ANDROID_KEYSTORE_PASSWORD`, which only `client-beta-apk\.yml:package-beta-apk` and `client-release\.yml:package-android` may reference; signing is isolated per site/,
  );

  // A reference from another workflow is refused even when the job name matches a
  // signing site: the closed table names its workflow.
  const otherWorkflow = await repositoryWorkflows();
  documentOf(otherWorkflow.documents, 'release.yml').steps
    .find((step) => step.job === 'record' && step.uses === 'actions/setup-node@v4')
    .env = new Map([['EXTRA', '${{ secrets.WINDOWS_CERTIFICATE }}']]);
  assert.throws(
    () => assertWithinBoundary(otherWorkflow),
    /step `Setup Node` env `EXTRA` reads `secrets\.WINDOWS_CERTIFICATE`, which only `client-release\.yml:package-windows` may reference; signing is isolated per site/,
  );
});

// #278/#322: a job-level write permission is confined to the job that holds it. The
// pipeline has two release writers, each named: the tag path's `publish` and the
// Beta path's dispatch-only `publish-beta-prerelease`. A third `contents: write`
// holder fails here.
test('#278: job-level write permissions are confined to their named sites', async () => {
  for (const [file, job, permission, expected] of [
    ['client-release.yml', 'publish', ['id-token', 'write'], /job `publish` grants `id-token: write`, which only `client-release\.yml:assemble` and `release\.yml:deploy` may hold/],
    ['client-release.yml', 'assemble', ['contents', 'write'], /job `assemble` grants `contents: write`, which only `client-beta-apk\.yml:publish-beta-prerelease` and `client-release\.yml:publish` may hold/],
    ['client-release.yml', 'assemble', ['artifact-metadata', 'write'], /job `assemble` grants `artifact-metadata: write`, which is not a reviewed job permission/],
    ['client-release.yml', 'verify', ['contents', 'write'], /job `verify` grants `contents: write`, which only `client-beta-apk\.yml:publish-beta-prerelease` and `client-release\.yml:publish` may hold/],
    ['client-beta-apk.yml', 'package-beta-apk', ['contents', 'write'], /job `package-beta-apk` grants `contents: write`, which only `client-beta-apk\.yml:publish-beta-prerelease` and `client-release\.yml:publish` may hold/],
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
    'client-beta-apk.yml:publish-beta-prerelease',
    'client-release.yml:assemble',
    'client-release.yml:publish',
    'release.yml:deploy',
  ]);
  // The merge path holds no release write: the Beta workflow's only write grant is
  // on the job a merge cannot run.
  assert.deepEqual(jobPermissionSites['client-beta-apk.yml:publish-beta-prerelease'], ['contents: write']);
  assert.equal(jobPermissionSites['client-beta-apk.yml:package-beta-apk'], undefined);
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
    // The guard job (#293) sits above this caller, so the line is read as a shape,
    // not a fixed offset: the subject here is the refusal message, not the offset.
    ['inherit', /check\.yml:\d+ job `build` must map the required secret explicitly instead of `secrets: inherit`/],
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

/**
 * The live workflows with one workflow replaced by the spliced text, re-parsed.
 * `file` defaults to the tag path so the #294 fixtures stay where they were; the
 * #322 fixtures splice into the Beta APK workflow, because the packaging-entry rules
 * govern both, and the #293 fixtures splice into whichever entry workflow they test.
 */
async function splicedSigningWorkflow(splice, file = signingWorkflows[0]) {
  const workflows = await repositoryWorkflows();
  const text = await readFile(new URL(file, workflowsDirectory), 'utf8');
  const spliced = splice(text);
  assert.notEqual(spliced, text, 'the fixture must change the checked-in workflow text');
  const index = workflows.documents.findIndex((document) => document.workflow.file === file);
  assert.ok(index >= 0, `expected a parsed ${file}`);
  workflows.documents[index] = parseWorkflow(spliced, file);
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

test('#294: command substitutions and background separators are scanned in run: bodies', async () => {
  for (const body of [
    'FOO=$(aws sts get-caller-identity)',
    'echo $(aws s3 ls)',
    '`aws s3 ls`',
    'true & aws s3 ls',
  ]) {
    const { workflows, text } = await splicedSigningWorkflow(withPreflightStep([
      '      - name: Cloud probe',
      '        run: |',
      `          ${body}`,
    ].join('\n')));
    assert.deepEqual(validateSourceCiCredentialBoundary(workflows), [
      `client-release.yml:${lineOf(text, `          ${body}`)} step \`Cloud probe\` runs \`aws\` in its \`run:\` body; the packaging entry runs no cloud CLI`,
    ]);
  }

  // The negatives prove the single-`&` split and the `$()`/backtick descent are not
  // a false-positive generator: redirections, a quoted URL, `aws-sdk` and prose stay
  // silent.
  for (const body of [
    'cmd 2>&1',
    'cmd &> /dev/null',
    '>&2 echo done',
    'curl "https://example.test/?a=1&b=2"',
    'echo aws-sdk',
    "echo 'prose mentions aws but runs no cloud CLI'",
  ]) {
    const { workflows } = await splicedSigningWorkflow(withPreflightStep([
      '      - name: Cloud probe',
      '        run: |',
      `          ${body}`,
    ].join('\n')));
    assert.deepEqual(validateSourceCiCredentialBoundary(workflows), []);
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
  const text = await readFile(new URL(signingWorkflows[0], workflowsDirectory), 'utf8');
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
    assert.throws(() => parseWorkflow(spliced, signingWorkflows[0]), expected);
  }
});

test('#294: the packaging-entry boundary is silent on the live workflows and fails closed without one', async () => {
  assert.deepEqual(validateSourceCiCredentialBoundary(await repositoryWorkflows()), []);

  // Each packaging entry is its own closed census: removing one reports exactly that
  // file as unverified and never accepts the other as a substitute.
  for (const file of signingWorkflows) {
    const workflows = await repositoryWorkflows();
    workflows.documents = workflows.documents.filter((document) => document.workflow.file !== file);
    assert.deepEqual(validateSourceCiCredentialBoundary(workflows), [
      `${file}:1 \`${file}\` was not parsed; the packaging-entry boundary is unverified`,
    ]);
  }
});

// #322: the packaging-entry rules govern both packaging workflows, so one
// representative fixture per rule is spliced into `client-beta-apk.yml` as well.
test('#322: the packaging-entry boundary refuses the same constructs in the Beta APK workflow', async () => {
  /** Splice one step before the Beta packaging job's `Checkout`. */
  const withBetaStep = (step) => (text) => spliceFirst(
    text,
    '      - name: Checkout\n',
    `${step}\n\n      - name: Checkout\n`,
  );

  const environment = await splicedSigningWorkflow(
    (text) => insertAfter(text, '    name: Package the Beta APK\n', '    environment: beta\n'),
    'client-beta-apk.yml',
  );
  assert.deepEqual(validateSourceCiCredentialBoundary(environment.workflows), [
    `client-beta-apk.yml:${lineOf(environment.text, '    environment: beta')} job \`package-beta-apk\` declares \`environment: beta\`; the packaging entry holds no GitHub Environment, so no job may declare one — the Client workflow census is authoritative in pipeline_stages.md § Protected entry points`,
  ]);

  const cloudAction = await splicedSigningWorkflow(
    withBetaStep('      - name: Cloud credentials\n        uses: aws-actions/configure-aws-credentials@v4'),
    'client-beta-apk.yml',
  );
  assert.deepEqual(validateSourceCiCredentialBoundary(cloudAction.workflows), [
    `client-beta-apk.yml:${lineOf(cloudAction.text, '      - name: Cloud credentials')} step \`Cloud credentials\` uses \`aws-actions/configure-aws-credentials@v4\`, a cloud-credential action (AWS); the packaging entry holds no cloud principal — adopting a cloud signing mechanism amends ADR-0036 §5 and the guard's signing table in the same delivery`,
  ]);

  const role = await splicedSigningWorkflow(withWorkflowEnv(roleVariable), 'client-beta-apk.yml');
  assert.deepEqual(validateSourceCiCredentialBoundary(role.workflows), [
    `client-beta-apk.yml:${lineOf(role.text, 'env:\n  EXTRA:')} workflow env \`EXTRA\` reads \`vars.CLIENT_PUBLISH_ROLE_ARN\`, a role-shaped variable; the packaging entry names no cloud role`,
  ]);

  const cloudCli = await splicedSigningWorkflow(
    withBetaStep('      - name: Cloud probe\n        run: |\n          aws sts get-caller-identity'),
    'client-beta-apk.yml',
  );
  assert.deepEqual(validateSourceCiCredentialBoundary(cloudCli.workflows), [
    `client-beta-apk.yml:${lineOf(cloudCli.text, '          aws sts get-caller-identity')} step \`Cloud probe\` runs \`aws\` in its \`run:\` body; the packaging entry runs no cloud CLI`,
  ]);
});

test('#294: the packaging-entry assertions are keyed to the packaging workflows, not every workflow', async () => {
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

  // Parsed under the packaging entry's file name, `release.yml` is exactly eleven
  // packaging-entry violations: one environment, one cloud-credential action, four
  // role-shaped references, one ARN and four cloud CLI invocations. Two of the four
  // are single-line `$(aws …)` substitutions the command-substitution scan reaches;
  // the publisher's substitutions opened across physical lines cannot be closed by a
  // per-line scan. Other validator rules also fire on this renamed document, so the
  // packaging-entry messages are filtered out by family first; the total pins the
  // else-if rule too, because a `with:` finding on the known AWS action would add one.
  const renamed = parseWorkflow(publisherText, signingWorkflows[0]);
  const violations = validateSourceCiCredentialBoundary({
    documents: [renamed],
    submoduleRepositories: parseGitmodules(await readFile(gitmodulesPath, 'utf8')),
    specificationRevision: await specificationGitlink(),
  });
  const packaging = violations.filter((message) => /declares `environment: |a cloud-credential action \(|passes `with: .*, a cloud-credential input|a role-shaped variable|whose name cannot be resolved|names `arn:aws|runs `[a-z]+` in its `run:` body/.test(message));
  assert.equal(packaging.length, 11);
  const families = (needle) => packaging.filter((message) => message.includes(needle));
  assert.equal(families('declares `environment: beta`').length, 1);
  assert.match(families('declares `environment: beta`')[0], /job `deploy` declares `environment: beta`/);
  assert.equal(families('a cloud-credential action (AWS)').length, 1);
  assert.match(families('a cloud-credential action (AWS)')[0], /uses `aws-actions\/configure-aws-credentials@v4`, a cloud-credential action \(AWS\)/);
  assert.equal(families('reads `vars.CLIENT_PUBLISH_ROLE_ARN`, a role-shaped variable').length, 4);
  assert.equal(families('names `arn:aws:sts::').length, 1);
  assert.equal(families('runs `aws` in its `run:` body').length, 4);
});

// #293: the guard job is self-enforcing. Each of the three entry workflows carries
// the same three-step `credential-boundary` job, and every signing site names it in
// `needs:`. Every fixture below splices the checked-in text, so a deleted job, a
// dropped or widened step, an added `secrets.` read, a removed ordering edge, a
// neutralising step key and a renamed reported check each fail the validator rather
// than only the review.

/** The `credential-boundary` job's text in one checked-in workflow. */
function guardJobText(text) {
  const marker = `  ${credentialBoundaryJob.id}:\n`;
  const start = text.indexOf(marker);
  assert.ok(start >= 0, `expected the fixture to declare ${credentialBoundaryJob.id}`);
  const rest = text.slice(start + marker.length);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  assert.ok(next >= 0, 'expected a job after the guard job');
  return text.slice(start, start + marker.length + next + 1);
}

test('#293: the three entry workflows declare the same gate job', async () => {
  const texts = [];
  for (const file of credentialBoundaryWorkflows) {
    texts.push(guardJobText(await readFile(new URL(file, workflowsDirectory), 'utf8')));
  }
  assert.equal(texts[1], texts[0], `${credentialBoundaryWorkflows[1]} declares the same gate job as ${credentialBoundaryWorkflows[0]}`);
  assert.equal(texts[2], texts[0], `${credentialBoundaryWorkflows[2]} declares the same gate job as ${credentialBoundaryWorkflows[0]}`);

  // The gate holds nothing an attacker could use to skip or widen it, and its three
  // steps are the ones the validator re-reads from `credentialBoundaryJob`.
  for (const forbidden of ['needs:', 'if:', 'secrets.', 'environment:']) {
    assert.equal(texts[0].includes(forbidden), false, `the gate job must declare no ${forbidden}`);
  }
  assert.equal(credentialBoundaryJob.steps.length, 3);
  for (const step of credentialBoundaryJob.steps) {
    const declaration = step.uses ?? step.run.join(' ');
    assert.ok(texts[0].includes(declaration), `the gate job must run \`${declaration}\``);
  }
});

test('#293: every signing site waits for the gate before it starts', async () => {
  const { documents } = await repositoryWorkflows();
  for (const [file, job, needs] of [
    ['client-release.yml', 'package-windows', ['preflight', 'credential-boundary']],
    ['client-release.yml', 'package-macos', ['preflight', 'credential-boundary']],
    ['client-release.yml', 'package-android', ['preflight', 'credential-boundary']],
    ['client-beta-apk.yml', 'package-beta-apk', ['credential-boundary']],
  ]) {
    const declared = documentOf(documents, file).workflow.jobs.find((candidate) => candidate.id === job);
    assert.ok(declared, `expected the ${job} job in ${file}`);
    assert.deepEqual(declared.needs?.jobs, needs, `${file}:${job} must wait for the gate`);
  }

  // Dropping the gate from a two-entry list leaves the job's other dependency behind,
  // so the fixture proves the omission is found, not that the block disappeared.
  const dropped = await splicedSigningWorkflow((text) => spliceFirst(
    text,
    '    needs: [preflight, credential-boundary]\n',
    '    needs: [preflight]\n',
  ));
  assert.deepEqual(validateSourceCiCredentialBoundary(dropped.workflows), [
    `client-release.yml:${lineOf(dropped.text, '  package-windows:\n')} job \`package-windows\` has \`needs: [preflight]\`, which omits \`credential-boundary\`; no signing site starts before the gate job has passed`,
  ]);

  // The Beta packaging job's only dependency is the gate, so its `needs:` block goes
  // away entirely — the one-entry form of the same omission.
  const removed = await splicedSigningWorkflow(
    (text) => spliceFirst(text, '    needs: [credential-boundary]\n', ''),
    'client-beta-apk.yml',
  );
  assert.deepEqual(validateSourceCiCredentialBoundary(removed.workflows), [
    `client-beta-apk.yml:${lineOf(removed.text, '  package-beta-apk:\n')} job \`package-beta-apk\` declares no \`needs:\`; every signing site must name \`credential-boundary\`, so none starts before the gate job has passed`,
  ]);
});

test('#293: deleting the gate job fails the boundary in every entry workflow', async () => {
  for (const file of credentialBoundaryWorkflows) {
    const { workflows, text } = await splicedSigningWorkflow(
      (source) => spliceFirst(source, guardJobText(source), ''),
      file,
    );
    assert.deepEqual(validateSourceCiCredentialBoundary(workflows), [
      `${file}:1 the \`credential-boundary\` job is missing; \`${file}\` must declare the gate job, so deleting it fails the boundary rather than removing its ordering rule`,
    ]);
    assert.equal(text.includes('  credential-boundary:\n'), false, 'the fixture must remove the job');
  }
});

test('#293: a secret, a dropped step, a condition or a dependency in the gate job is refused', async () => {
  // A `secrets.` reference added to the gate's Setup Node step is refused three times:
  // the gate rule finds it in the job body, the step-shape rule refuses the widened
  // step, and the repository-wide scan refuses the secret at that job.
  const secret = '${{ secrets.APPLE_CERTIFICATE }}';
  const widened = await splicedSigningWorkflow(
    (source) => {
      const guard = guardJobText(source);
      return spliceFirst(source, guard, insertAfter(guard, '          node-version: 24\n', `        env:\n          EXTRA: ${secret}\n`));
    },
    credentialBoundaryWorkflows[0],
  );
  const flagged = validateSourceCiCredentialBoundary(widened.workflows);
  const secretLine = lineOf(widened.text, `          EXTRA: ${secret}`);
  assert.deepEqual(
    flagged.filter((message) => message.includes('job `credential-boundary` reads')),
    [`check.yml:${secretLine} job \`credential-boundary\` reads \`secrets.APPLE_CERTIFICATE\`; the gate job holds no \`needs:\`, \`if:\`, \`secrets.\` or \`environment:\`, so it cannot be skipped or widened`],
  );
  assert.ok(
    flagged.some((message) => /step `Setup Node 24` env `EXTRA` reads `secrets\.APPLE_CERTIFICATE`, which only `client-release\.yml:package-macos` may reference/.test(message)),
    'the repository-wide scan must refuse the secret at the gate job too',
  );
  assert.ok(
    flagged.some((message) => /step 2 of job `credential-boundary` must be `uses: actions\/setup-node@v4` with `node-version: 24`, found .*env `EXTRA:/.test(message)),
    'the widened step must be refused as a shape change',
  );

  // A dropped step leaves the job short of the three the gate declares.
  const setupNodeStep = [
    '      - name: Setup Node 24',
    '        uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 24',
    '',
  ].join('\n');
  const droppedStep = await splicedSigningWorkflow(
    (source) => {
      const guard = guardJobText(source);
      return spliceFirst(source, guard, spliceFirst(guard, setupNodeStep, ''));
    },
    credentialBoundaryWorkflows[0],
  );
  assert.deepEqual(validateSourceCiCredentialBoundary(droppedStep.workflows), [
    `check.yml:${lineOf(droppedStep.text, '  credential-boundary:\n')} job \`credential-boundary\` declares 2 step(s); it must declare exactly 3 — \`uses: actions/checkout@v4\` with \`persist-credentials: false\`, \`uses: actions/setup-node@v4\` with \`node-version: 24\`, \`run: node --test scripts/source-ci-credential-boundary.node-test.mjs\` — so a dropped or widened step fails the boundary`,
  ]);

  // A condition is what would let the gate be skipped; a dependency is what would
  // let it start behind something else. Both are refused on their own line.
  const conditioned = await splicedSigningWorkflow(
    (source) => {
      const guard = guardJobText(source);
      return spliceFirst(source, guard, insertAfter(guard, `  ${credentialBoundaryJob.id}:\n`, "    if: github.event_name == 'push'\n"));
    },
    credentialBoundaryWorkflows[0],
  );
  const conditionLine = lineOf(conditioned.text, "    if: github.event_name == 'push'");
  assert.deepEqual(validateSourceCiCredentialBoundary(conditioned.workflows), [
    `check.yml:${conditionLine} job \`credential-boundary\` declares \`if:\`; the gate job holds no \`needs:\`, \`if:\`, \`secrets.\` or \`environment:\`, so it cannot be skipped or widened`,
  ]);

  const dependent = await splicedSigningWorkflow(
    (source) => {
      const guard = guardJobText(source);
      return spliceFirst(source, guard, insertAfter(guard, `  ${credentialBoundaryJob.id}:\n`, '    needs: [build]\n'));
    },
    credentialBoundaryWorkflows[0],
  );
  const dependencyLine = lineOf(dependent.text, '    needs: [build]\n    name: Credential Boundary');
  assert.deepEqual(validateSourceCiCredentialBoundary(dependent.workflows), [
    `check.yml:${dependencyLine} job \`credential-boundary\` declares \`needs:\`; the gate job holds no \`needs:\`, \`if:\`, \`secrets.\` or \`environment:\`, so it cannot be skipped or widened`,
  ]);
});

// #293: the reported check name and the gate steps' own keys. GitHub reports a job's
// `name:` as the check name, and a ruleset pins that string, so a rename must fail
// here even when all three workflows agree. A `continue-on-error:` or a step-level
// `if:` would leave `Credential Boundary` green after a failed boundary test, so both
// are refused in either form — and the fixtures splice text, which is what proves the
// parser records the key rather than the validator comparing values it was handed.
test('#293: the gate job reports the one pinned check name in every entry workflow', async () => {
  assert.equal(credentialBoundaryJob.name, 'Credential Boundary');

  const { documents } = await repositoryWorkflows();
  for (const file of credentialBoundaryWorkflows) {
    const declared = documentOf(documents, file).workflow.jobs.find((job) => job.id === credentialBoundaryJob.id);
    assert.ok(declared, `expected the gate job in ${file}`);
    assert.equal(declared.name?.value, 'Credential Boundary', `${file} reports the pinned check name`);
  }

  const renamed = await splicedSigningWorkflow(
    (source) => spliceFirst(source, '    name: Credential Boundary\n', '    name: Credential Gate\n'),
    credentialBoundaryWorkflows[0],
  );
  assert.deepEqual(validateSourceCiCredentialBoundary(renamed.workflows), [
    `check.yml:${lineOf(renamed.text, '    name: Credential Gate')} job \`credential-boundary\` declares \`name: Credential Gate\`; the reported check name must be \`Credential Boundary\`, which is the string a ruleset pins as a required status check`,
  ]);

  const unnamed = await splicedSigningWorkflow(
    (source) => spliceFirst(source, '    name: Credential Boundary\n', ''),
    credentialBoundaryWorkflows[0],
  );
  assert.deepEqual(validateSourceCiCredentialBoundary(unnamed.workflows), [
    `check.yml:${lineOf(unnamed.text, '  credential-boundary:\n')} job \`credential-boundary\` declares no \`name:\`; the reported check name must be \`Credential Boundary\`, which is the string a ruleset pins as a required status check`,
  ]);
});

test('#293: a neutralising key on a step of the gate job is refused in either form', async () => {
  // The gate's third step is the `run:` that executes this file's own test, so it is
  // the step a neutralising key would silence.
  const guardRun = '        run: node --test scripts/source-ci-credential-boundary.node-test.mjs\n';
  for (const [addition, key] of [
    ['        continue-on-error: true\n', 'continue-on-error'],
    ['        continue-on-error:\n          value: true\n', 'continue-on-error'],
    ['        if: false\n', 'if'],
    ['        if:\n          value: false\n', 'if'],
  ]) {
    const { workflows, text } = await splicedSigningWorkflow(
      (source) => insertAfter(source, guardRun, addition),
      credentialBoundaryWorkflows[0],
    );
    assert.deepEqual(validateSourceCiCredentialBoundary(workflows), [
      `check.yml:${lineOf(text, addition)} step 3 of job \`credential-boundary\` declares \`${key}:\`; the gate job's steps hold no \`continue-on-error:\` or \`if:\`, so a failed boundary test cannot leave \`Credential Boundary\` green`,
    ], `expected \`${key}:\` written as ${addition.includes('\n          ') ? 'a block' : 'a scalar'} to be refused`);
  }

  // The same key on the step's `- ` line is the same entry as one written below it,
  // so the first-line source of a step is read too.
  const firstLine = await splicedSigningWorkflow(
    (source) => spliceFirst(
      source,
      '      - name: Run the credential-boundary guard\n',
      '      - if: false\n        name: Run the credential-boundary guard\n',
    ),
    credentialBoundaryWorkflows[0],
  );
  assert.deepEqual(validateSourceCiCredentialBoundary(firstLine.workflows), [
    `check.yml:${lineOf(firstLine.text, '      - if: false')} step 3 of job \`credential-boundary\` declares \`if:\`; the gate job's steps hold no \`continue-on-error:\` or \`if:\`, so a failed boundary test cannot leave \`Credential Boundary\` green`,
  ]);
});

test('#294: the guard signing names match the env-scope allowlist', async () => {
  // Read as text, not imported: a test that imports its subject verifies nothing,
  // and the env-scope file is a test file, not a module this suite may execute.
  const envScopeText = await readFile(new URL('env-scope.node-test.mjs', import.meta.url), 'utf8');
  const secretsBlock = /^ {2}secrets: \[\n([\s\S]*?)^ {2}\],/m.exec(envScopeText)?.[1];
  assert.ok(secretsBlock, 'env-scope.node-test.mjs must declare REPOSITORY_SCOPED.secrets as a list');
  const envScopeSecrets = [...secretsBlock.matchAll(/^ {4}'([A-Z0-9_]+)',$/gm)].map((match) => match[1]);
  const signingNames = [...new Set(Object.values(signingSites).flat())].sort();
  assert.deepEqual(signingNames, envScopeSecrets.filter((name) => name !== 'APP_PRIVATE_KEY').sort());
  assert.equal(signingNames.length, 9, 'still nine distinct signing secret names; the Beta path adds no secret');
  // #322: nine names across four `workflow:job` sites, so the two tables stay in step
  // about which sites admit them.
  assert.equal(Object.keys(signingSites).length, 4, 'the four named sites admit the nine names');
  assert.deepEqual([...signingSecretSites.keys()].sort(), signingNames);
  for (const sites of signingSecretSites.values()) {
    assert.ok(sites.size >= 1 && sites.size <= 2, 'a signing secret is admitted at one or two named sites, never more');
  }
  assert.match(envScopeText, /^const ENVIRONMENT_SCOPED = \[\];$/m);
});
