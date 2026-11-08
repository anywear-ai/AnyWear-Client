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
    // Repository-scoped: App id used to mint the API-spec token; resolvable before any environment exists.
    'APP_ID',
    // Repository-scoped: Beta account asserted before any AWS call; resolvable before any environment exists.
    'AWS_ACCOUNT_ID',
    // Repository-scoped: Beta region asserted before any AWS call; resolvable before any environment exists.
    'AWS_REGION',
    // Repository-scoped: dedicated Beta publish-role ARN; resolvable before any environment exists.
    'CLIENT_PUBLISH_ROLE_ARN',
    // Repository-scoped: the single stage switch that gates the deploy chain; resolvable before any environment exists.
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
    // alias and key password; read only by `package-android` in `client-release.yml`.
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

test('a job without an environment reads only repository-scoped configuration', () => {
  let jobsWithEnvironment = 0;
  for (const file of workflowFiles) {
    for (const job of jobEntries(read(file))) {
      if (declaresEnvironment(job.section)) {
        jobsWithEnvironment += 1;
        continue;
      }
      for (const reference of references(job.section)) {
        assert.ok(
          !ENVIRONMENT_SCOPED.includes(reference.name),
          `${file}:${job.name} reads ${reference.kind}.${reference.name} without declaring \`environment:\`, so the value would resolve empty`,
        );
      }
    }
  }
  assert.ok(jobsWithEnvironment > 0, 'at least one job must declare an environment for this guard to be meaningful');
});

test('the publication chain keeps the publish role at repository scope until the single environment job', () => {
  const release = read('release.yml');
  const jobs = Object.fromEntries(jobEntries(release).map((job) => [job.name, job.section]));
  assert.deepEqual(Object.keys(jobs), ['build', 'verify', 'deploy', 'record', 'handoff']);

  // One environment, one OIDC token, and only on the job that publishes.
  const withEnvironment = Object.keys(jobs).filter((name) => declaresEnvironment(jobs[name]));
  assert.deepEqual(withEnvironment, ['deploy'], 'only deploy may declare an environment');
  assert.match(jobs.deploy, /^ {4}environment: beta$/m);

  const withIdToken = Object.keys(jobs).filter((name) => /^ {6}id-token:/m.test(jobs[name]));
  assert.deepEqual(withIdToken, ['deploy'], 'only deploy may declare an OIDC token');
  assert.match(jobs.deploy, /^ {6}id-token: write$/m);

  // The publishing job is where the role is assumed, and it is the only one
  // allowed to resolve it behind an environment.
  assert.match(jobs.deploy, /^ {10}role-to-assume: \$\{\{ vars\.CLIENT_PUBLISH_ROLE_ARN \}\}$/m);

  // verify and record must keep resolving the role at repository scope: no
  // environment, no OIDC token, and no other spelling of the name.
  for (const name of ['verify', 'record']) {
    assert.doesNotMatch(jobs[name], /^ {4}environment:/m, `${name} must not declare an environment`);
    assert.doesNotMatch(jobs[name], /^ {6}id-token:/m, `${name} must not declare an OIDC token`);
    const roleExpressions = [...jobs[name].matchAll(/\$\{\{[^}]*CLIENT_PUBLISH_ROLE_ARN[^}]*\}\}/g)].map((match) => match[0]);
    assert.ok(roleExpressions.length > 0, `${name} must keep the repository-scoped publish role reference`);
    for (const expression of roleExpressions) {
      assert.equal(expression, '${{ vars.CLIENT_PUBLISH_ROLE_ARN }}', `${name} must resolve the role at repository scope`);
    }
  }

  // `handoff` dispatches after the record and holds nothing but a scoped name to read.
  assert.doesNotMatch(jobs.handoff, /^ {4}environment:/m, 'handoff must not declare an environment');
  assert.doesNotMatch(jobs.handoff, /^ {6}id-token:/m, 'handoff must not declare an OIDC token');
  assert.doesNotMatch(jobs.handoff, /configure-aws-credentials/, 'handoff must not acquire AWS credentials');
  assert.doesNotMatch(jobs.handoff, /CLIENT_PUBLISH_ROLE_ARN/, 'handoff must not read the publish role');
  // The App identity it mints a token with is repository-scoped, so it resolves
  // before any environment exists.
  assert.deepEqual(references(jobs.handoff).map((reference) => `${reference.kind}.${reference.name}`).sort(), ['secrets.APP_PRIVATE_KEY', 'vars.APP_ID']);
  assert.ok(REPOSITORY_SCOPED.vars.includes('APP_ID'), 'vars.APP_ID is configured at repository scope');
  assert.ok(REPOSITORY_SCOPED.secrets.includes('APP_PRIVATE_KEY'), 'secrets.APP_PRIVATE_KEY is configured at repository scope');
  // The values it needs to reach the receiver are workflow text, not configuration.
  // The REST path is owner-qualified; the token input below names the bare repository.
  assert.match(jobs.handoff, /^ {6}E2E_OWNER: \$\{\{ github\.repository_owner \}\}$/m);
  assert.match(jobs.handoff, /^ {6}E2E_REPOSITORY: AnyWear-E2E$/m);
  assert.match(jobs.handoff, /^ {6}E2E_WORKFLOW: beta-qualification\.yml$/m);
  assert.match(jobs.handoff, /repos\/\$\{E2E_OWNER\}\/\$\{E2E_REPOSITORY\}\/actions\/workflows\/\$\{E2E_WORKFLOW\}/);

  // The chain order is explicit and survives any edit to the sections above.
  assert.doesNotMatch(jobs.build, /^ {4}needs:/m, 'build is the first job of the chain');
  assert.match(jobs.verify, /^ {4}needs: \[build\]$/m);
  assert.match(jobs.deploy, /^ {4}needs: \[verify\]$/m);
  assert.match(jobs.record, /^ {4}needs: \[deploy\]$/m);
  assert.match(jobs.handoff, /^ {4}needs: \[record\]$/m);
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

  // build, verify and deploy read the override or the constant in the same
  // expression, so a push and a dispatch compile the same recorded interface.
  const jobs = Object.fromEntries(jobEntries(release).map((job) => [job.name, job.section]));
  for (const [job, prefix] of [['build', 'VITE'], ['verify', 'DECLARED'], ['deploy', 'DECLARED']]) {
    assert.match(jobs[job], new RegExp(`^ {10}${prefix}_API_BASE_URL: \\$\\{\\{ inputs\\.api_base_url \\|\\| env\\.BETA_API_BASE_URL \\}\\}$`, 'm'), `${job} must read the API base URL from the input or the constant`);
    assert.match(jobs[job], new RegExp(`^ {10}${prefix}_COGNITO_USER_POOL_ID: \\$\\{\\{ inputs\\.cognito_user_pool_id \\|\\| env\\.BETA_COGNITO_USER_POOL_ID \\}\\}$`, 'm'), `${job} must read the user pool from the input or the constant`);
    assert.match(jobs[job], new RegExp(`^ {10}${prefix}_COGNITO_CLIENT_ID: \\$\\{\\{ inputs\\.cognito_client_id \\|\\| env\\.BETA_COGNITO_CLIENT_ID \\}\\}$`, 'm'), `${job} must read the client id from the input or the constant`);
  }
});

test('the automatic entry stays automatic and the publication entry stays the only dispatch surface', () => {
  const dispatchSurfaces = workflowFiles.filter((file) => /^ {2}workflow_dispatch:$/m.test(read(file)));
  assert.deepEqual(dispatchSurfaces, ['release.yml']);

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

// #278: the nine signing secrets are repository-scoped, and each is read by one
// platform job only. GitHub does not scope a repository secret to a job at runtime,
// so this source allowlist is the review-time boundary: an unreviewed reference in
// another job fails `pnpm run test:run` instead of silently widening the blast
// radius at the next tag.
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

  // The other four jobs are denied every signing name in source; `preflight` in
  // particular never reads a secret, so missing credentials cannot fail it.
  const denied = jobs.filter((job) => !designatedJobs.has(job.name));
  assert.deepEqual(denied.map((job) => job.name), ['preflight', 'verify', 'assemble', 'publish']);
  for (const job of denied) {
    assert.doesNotMatch(job.section, /secrets\./, `${job.name} must not reference any secret`);
  }

  // The environment posture is unchanged: no signing secret needs an environment.
  assert.deepEqual(ENVIRONMENT_SCOPED, []);
  assert.deepEqual(REPOSITORY_SCOPED.secrets.length, 10, 'the app key plus the nine signing secrets');
});
