import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// #163: an environment-scope guard for workflow configuration.
//
// The defect class: a job reads a configuration name that is configured at
// environment scope while the job declares no `environment`, so GitHub resolves
// it as empty and the failure only surfaces at the credentialed step. Client hit
// the same class as Infra and E2E. The fix was at the configuration layer
// (repository-scoped variables, no stale beta switch); this file makes the
// structure that prevented the defect visible in source, so a regression fails
// `pnpm run test:run` instead of the next deploy.
//
// The text is sliced without a YAML dependency, in the same style as the other
// repository source guards.

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const workflowsDirectory = join(repositoryRoot, '.github', 'workflows');
const workflowFiles = readdirSync(workflowsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
  .map((entry) => entry.name)
  .sort();
const read = (name) => readFileSync(join(workflowsDirectory, name), 'utf8');

// The explicit allowlist of configuration names a job without `environment:`
// may read. Every name here is configured at repository scope, so it is
// resolvable before any environment exists. This list is a deliberate
// maintenance point: adding a name is a scope decision, and removing the last
// reference to a name must also prune it here (stale entries fail).
const REPOSITORY_SCOPED = {
  vars: [
    // Repository-scoped: App id used to mint the API-spec token and the Infra
    // handoff token; resolvable before any environment exists.
    'APP_ID',
    // Repository-scoped: the single stage switch that gates the handoff chain; resolvable before any environment exists.
    'ENABLE_BETA_MUTATION',
  ],
  secrets: [
    // Repository-scoped: App private key used only by the API-spec token step; resolvable before any environment exists.
    'APP_PRIVATE_KEY',
    // Repository-scoped: the Windows OV code-signing PFX (base64) and its export
    // password; read only by `package-windows` in `client-release.yml`.
    'WINDOWS_CERTIFICATE',
    'WINDOWS_CERTIFICATE_PASSWORD',
    // Repository-scoped: the macOS Developer ID Application `.p12` (base64), its
    // password and the App Store Connect API `.p8` (base64); read only by
    // `package-macos` in `client-release.yml`.
    'APPLE_CERTIFICATE',
    'APPLE_CERTIFICATE_PASSWORD',
    'APPLE_API_KEY_P8',
    // Repository-scoped: the Android upload keystore (base64), its password, key
    // alias and key password; read only by `client-release.yml:package-android` and
    // `client-beta-apk.yml:package-beta-apk`.
    'ANDROID_KEY_BASE64',
    'ANDROID_KEYSTORE_PASSWORD',
    'ANDROID_KEY_ALIAS',
    'ANDROID_KEY_PASSWORD',
  ],
};

// Configuration names that resolve only after the job enters its environment.
// The list is empty today: every name the workflows read is configured at
// repository scope. Populating it is a deliberate decision, and the referencing
// job must then declare `environment:`, or this guard fails. Adding a name here
// is not a way to make a reference pass silently.
const ENVIRONMENT_SCOPED = [];

const configurationReference = /\$\{\{\s*(vars|secrets)\.([A-Za-z0-9_]+)\s*\}\}/g;

/** The `vars.*` / `secrets.*` expressions a block of workflow text contains. */
function references(text) {
  return [...text.matchAll(configurationReference)].map((match) => ({ kind: match[1], name: match[2] }));
}

/** The workflow's jobs, each with the text of its section, in file order. */
function jobEntries(workflow) {
  const marker = '\njobs:\n';
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, 'the workflow must declare a top-level `jobs:` block');
  const body = workflow.slice(start + marker.length);
  const headers = [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):\n/gm)];
  assert.ok(headers.length > 0, 'the workflow must declare at least one job');
  return headers.map((header, index) => ({
    name: header[1],
    section: body.slice(header.index, index + 1 < headers.length ? headers[index + 1].index : body.length),
  }));
}

/** Whether a job section declares a job-level `environment:`. */
function declaresEnvironment(section) {
  return /^ {4}environment:/m.test(section);
}

test('every configuration reference declares a repository or environment scope', () => {
  const declared = new Set();
  for (const file of workflowFiles) {
    for (const job of jobEntries(read(file))) {
      for (const reference of references(job.section)) {
        const key = `${reference.kind}.${reference.name}`;
        declared.add(key);
        assert.ok(
          REPOSITORY_SCOPED[reference.kind].includes(reference.name) || ENVIRONMENT_SCOPED.includes(reference.name),
          `${file}:${job.name} reads ${key}, which is not in REPOSITORY_SCOPED or ENVIRONMENT_SCOPED; decide and document its scope`,
        );
      }
    }
  }

  // The allowlist is a decision log, not a lint suppression: an entry nothing
  // references any more must be pruned deliberately so the list cannot drift.
  assert.ok(declared.size > 0, 'the workflows must reference production configuration for this guard to be meaningful');
  for (const kind of ['vars', 'secrets']) {
    for (const name of REPOSITORY_SCOPED[kind]) {
      assert.ok(declared.has(`${kind}.${name}`), `${kind}.${name} is allowlisted as repository-scoped but no workflow references it`);
    }
  }
});

test('no job declares an environment, and every job reads repository-scoped configuration', () => {
  let jobsWithoutEnvironment = 0;
  for (const file of workflowFiles) {
    for (const job of jobEntries(read(file))) {
      // #344: the Client holds no GitHub Environment at all. The web publication's
      // `beta` environment retired with its AWS role, so the environment-scope
      // defect class cannot reach this repository any more; what this guard still
      // proves is that no job reads a name that would resolve empty.
      assert.equal(
        declaresEnvironment(job.section),
        false,
        `${file}:${job.name} declares \`environment:\`; the Client holds no environment`,
      );
      jobsWithoutEnvironment += 1;
      for (const reference of references(job.section)) {
        assert.ok(
          !ENVIRONMENT_SCOPED.includes(reference.name),
          `${file}:${job.name} reads ${reference.kind}.${reference.name} without declaring \`environment:\`, so the value would resolve empty`,
        );
      }
    }
  }
  assert.ok(jobsWithoutEnvironment > 0, 'the workflows must declare jobs for this guard to be meaningful');
});

test('the publication chain holds no environment, no OIDC token and no AWS role', () => {
  const release = read('release.yml');
  const jobs = Object.fromEntries(jobEntries(release).map((job) => [job.name, job.section]));
  assert.deepEqual(Object.keys(jobs), ['build', 'verify', 'handoff']);

  // #344: the Client builds, verifies and hands off. The AWS write moved into
  // `AnyWear-Infra`'s `publish-client`, so no job here declares an environment, mints
  // an OIDC identity or reads a role. Each of these is a negative pin on the retired
  // `deploy` and `record` jobs.
  for (const name of Object.keys(jobs)) {
    assert.doesNotMatch(jobs[name], /^ {4}environment:/m, `${name} must not declare an environment`);
    assert.doesNotMatch(jobs[name], /^ {6}id-token:/m, `${name} must not declare an OIDC token`);
    assert.doesNotMatch(jobs[name], /configure-aws-credentials/, `${name} must not acquire AWS credentials`);
    assert.doesNotMatch(jobs[name], /aws (?:sts|s3|cloudformation|ssm|cloudfront)\b/, `${name} must not run the AWS CLI`);
    assert.doesNotMatch(jobs[name], /CLIENT_PUBLISH_ROLE_ARN|role-to-assume|arn:aws:/, `${name} must not name an AWS role or ARN`);
  }
  assert.doesNotMatch(release, /AWS_ACCOUNT_ID|AWS_REGION/, 'no job asserts an AWS account or region any more');

  // `handoff` is the one job that reaches another repository, and it holds nothing
  // but the App identity it mints a token with.
  assert.deepEqual(references(jobs.handoff).map((reference) => `${reference.kind}.${reference.name}`).sort(), ['secrets.APP_PRIVATE_KEY', 'vars.APP_ID']);
  assert.ok(REPOSITORY_SCOPED.vars.includes('APP_ID'), 'vars.APP_ID is configured at repository scope');
  assert.ok(REPOSITORY_SCOPED.secrets.includes('APP_PRIVATE_KEY'), 'secrets.APP_PRIVATE_KEY is configured at repository scope');
  // The values it needs to reach the receiver are workflow text, not configuration.
  // The REST path is owner-qualified; the token input below names the bare repository.
  assert.match(jobs.handoff, /^ {6}INFRA_OWNER: \$\{\{ github\.repository_owner \}\}$/m);
  assert.match(jobs.handoff, /^ {6}INFRA_REPOSITORY: AnyWear-Infra$/m);
  assert.match(jobs.handoff, /^ {6}INFRA_WORKFLOW: mutate\.yml$/m);
  assert.match(jobs.handoff, /^ {6}CLIENT_BUNDLE_DIGEST: \$\{\{ needs\.build\.outputs\.client_bundle_digest \}\}$/m);
  assert.match(jobs.handoff, /^ {10}repositories: AnyWear-Infra$/m);
  assert.match(jobs.handoff, /^ {10}permission-actions: write$/m);

  // The chain order is explicit and survives any edit to the sections above.
  assert.doesNotMatch(jobs.build, /^ {4}needs:/m, 'build is the first job of the chain');
  assert.match(jobs.verify, /^ {4}needs: \[build\]$/m);
  assert.match(jobs.handoff, /^ {4}needs: \[build, verify\]$/m);
});

test('the reviewed Beta interface is literal workflow env, not repository configuration', () => {
  const release = read('release.yml');
  const constants = /^env:\n((?: {2}[A-Z0-9_]+: .*(?:\n|$))+)/m.exec(release)?.[1];
  assert.equal(
    constants,
    "  BETA_API_BASE_URL: 'https://d1pfqujqt29n11.cloudfront.net'\n"
    + "  BETA_COGNITO_USER_POOL_ID: 'ap-east-1_XqXt4Kw1L'\n"
    + "  BETA_COGNITO_CLIENT_ID: '4jp37atfitq59hmjo404342int'\n",
    'the three constants are literal workflow env, reviewed with the workflow',
  );

  // No job resolves the interface from repository or environment configuration,
  // which is what would let the value change between review and run.
  for (const file of workflowFiles) {
    assert.doesNotMatch(read(file), /vars\.(?:BETA_|API_BASE_URL|COGNITO_)/, `${file} must not read the interface from vars`);
  }

  // build and verify read the override or the constant in the same expression, so a
  // push and a dispatch compile and check the same recorded interface.
  const jobs = Object.fromEntries(jobEntries(release).map((job) => [job.name, job.section]));
  for (const [job, prefix] of [['build', 'VITE'], ['verify', 'DECLARED']]) {
    assert.match(jobs[job], new RegExp(`^ {10}${prefix}_API_BASE_URL: \\$\\{\\{ inputs\\.api_base_url \\|\\| env\\.BETA_API_BASE_URL \\}\\}$`, 'm'), `${job} must read the API base URL from the input or the constant`);
    assert.match(jobs[job], new RegExp(`^ {10}${prefix}_COGNITO_USER_POOL_ID: \\$\\{\\{ inputs\\.cognito_user_pool_id \\|\\| env\\.BETA_COGNITO_USER_POOL_ID \\}\\}$`, 'm'), `${job} must read the user pool from the input or the constant`);
    assert.match(jobs[job], new RegExp(`^ {10}${prefix}_COGNITO_CLIENT_ID: \\$\\{\\{ inputs\\.cognito_client_id \\|\\| env\\.BETA_COGNITO_CLIENT_ID \\}\\}$`, 'm'), `${job} must read the client id from the input or the constant`);
  }
});

test('the automatic entry stays automatic and the two named entries are the dispatch surfaces', () => {
  const dispatchSurfaces = workflowFiles.filter((file) => /^ {2}workflow_dispatch:$/m.test(read(file)));
  assert.deepEqual(dispatchSurfaces, ['client-beta-apk.yml', 'release.yml']);

  const check = read('check.yml');
  assert.doesNotMatch(check, /workflow_dispatch/);
  assert.match(check, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {4}branches: \[main\]\n/m);

  // The publication entry adds the merge event; it is not a second automatic check.
  // The trigger order is asserted without pinning the old adjacency: the 14-line
  // #268 declaration sits between `on:` and `push:`, and `paths-ignore` sits
  // between `branches: [main]` and `workflow_dispatch:`.
  const release = read('release.yml');
  const onMatch = /^on:\n/m.exec(release);
  assert.ok(onMatch, 'release.yml must declare a top-level `on:` block');
  const afterOn = release.slice(onMatch.index + onMatch[0].length);
  const nextTopLevel = afterOn.search(/^[a-z][a-z0-9-]*:\n/m);
  const on = afterOn.slice(0, nextTopLevel < 0 ? undefined : nextTopLevel);
  assert.deepEqual([...on.matchAll(/^ {2}([a-z_]+):$/gm)].map((match) => match[1]), ['push', 'workflow_dispatch']);
  const pushStart = on.indexOf('  push:\n');
  const dispatchAt = on.indexOf('  workflow_dispatch:\n', pushStart);
  assert.ok(pushStart >= 0 && dispatchAt > pushStart, 'release.yml must declare the push trigger before the dispatch');
  const push = on.slice(pushStart + '  push:\n'.length, dispatchAt);
  assert.match(push, /^ {4}branches: \[main\]$/m);
  assert.match(push, /^ {4}paths-ignore:\n {6}- '\*\*\/\*\.md'$/m);
});

// #278/#322: the nine signing secrets are repository-scoped, and each is read by
// its named site only — one platform job for the nine desktop and Android names,
// and two named Android sites for the four `ANDROID_*` secrets, because the merge
// Beta path packages Android too. GitHub does not scope a repository secret to a
// job at runtime, so this source allowlist is the review-time boundary: an
// unreviewed reference in another job fails `pnpm run test:run` instead of silently
// widening the blast radius at the next tag or merge.
const SIGNING_SECRET_SITES = {
  WINDOWS_CERTIFICATE: 'package-windows',
  WINDOWS_CERTIFICATE_PASSWORD: 'package-windows',
  APPLE_CERTIFICATE: 'package-macos',
  APPLE_CERTIFICATE_PASSWORD: 'package-macos',
  APPLE_API_KEY_P8: 'package-macos',
  ANDROID_KEY_BASE64: 'package-android',
  ANDROID_KEYSTORE_PASSWORD: 'package-android',
  ANDROID_KEY_ALIAS: 'package-android',
  ANDROID_KEY_PASSWORD: 'package-android',
};

test('#278: each signing secret is read only by its designated platform job', () => {
  const jobs = jobEntries(read('client-release.yml'));
  const designatedJobs = new Set(Object.values(SIGNING_SECRET_SITES));
  for (const [secret, site] of Object.entries(SIGNING_SECRET_SITES)) {
    assert.ok(REPOSITORY_SCOPED.secrets.includes(secret), `${secret} must be allowlisted as repository-scoped`);
    const reference = new RegExp(`\\$\\{\\{\\s*secrets\\.${secret}\\s*\\}\\}`);
    const holders = jobs.filter((job) => reference.test(job.section)).map((job) => job.name);
    assert.deepEqual(holders, [site], `${secret} may be read only by ${site}`);
  }

  // Every job outside the three signing sites is denied every signing name in
  // source; `preflight` in particular never reads a secret, so missing credentials
  // cannot fail it. The `credential-boundary` gate (#293) is denied by the same rule.
  const denied = jobs.filter((job) => !designatedJobs.has(job.name));
  assert.deepEqual(denied.map((job) => job.name), ['credential-boundary', 'preflight', 'verify', 'assemble', 'publish']);
  for (const job of denied) {
    assert.doesNotMatch(job.section, /secrets\./, `${job.name} must not reference any secret`);
  }

  // The environment posture is unchanged: no signing secret needs an environment.
  assert.deepEqual(ENVIRONMENT_SCOPED, []);
  assert.deepEqual(REPOSITORY_SCOPED.secrets.length, 10, 'the app key plus the nine signing secrets');
});
