import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// #163: the repository-side census of the entry face. Client ends this change with
// exactly three entries — one automatic check, one tag-triggered binary publication
// (#278) and one publication entry that runs on a merge to `main` and on a manual
// dispatch — one dispatch surface and one activation switch, and the publication
// chain keeps the only AWS-credential job behind the credential-free verify job with
// a credential-free record job after it and a credential-free dispatch job after
// that. These are source assertions, read as text with no YAML dependency, so the
// next change cannot drift the entry face without failing `pnpm run test:run`.

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const workflowsDirectory = join(repositoryRoot, '.github', 'workflows');
const workflowFiles = readdirSync(workflowsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
  .map((entry) => entry.name)
  .sort();
const read = (name) => readFileSync(join(workflowsDirectory, name), 'utf8');

const automaticEntry = 'check.yml';
const tagEntry = 'client-release.yml';
const manualEntry = 'release.yml';
const calledWorkflows = ['build.yml', 'test.yml', 'browser.yml', 'tauri-smoke.yml'];

// #268: the one `paths-ignore` declaration a `main`-push trigger carries. The literal
// is the contract — ten comment lines, then the trigger with the single quoted
// pattern — so an edit to either the comments or the pattern fails this guard.
const PATHS_IGNORE_DECLARATION = [
  '  # A merge whose changed files are all documentation starts nothing: every changed',
  '  # path matches `paths-ignore`, so the run is skipped before any job — no artifact',
  '  # is published, no deployment is handed off and no bundle is synced.',
  '  # A file outside the list still starts the chain, because `paths-ignore` skips only',
  '  # when every changed path matches: one source file beside one document deploys.',
  '  # The twin declaration is the `push` trigger in the other repository: this list is',
  '  # carried verbatim by AnyWear-Service/.github/workflows/service-beta.yml and',
  '  # AnyWear-Client/.github/workflows/release.yml.',
  '  # Landing this filter is itself a non-documentation merge: it starts one run in each',
  '  # repository. It is the last merge of this documentation delivery that deploys.',
  '  push:',
  '    branches: [main]',
  '    paths-ignore:',
  "      - '**/*.md'",
].join('\n');

// #268: GitHub's documented path-filter matcher. `path.matchesGlob` would certify the
// wrong outcome — it excludes dot directories, so `.github/DEPLOYMENT.md` misses
// `**/*.md` although GitHub's rule matches it — so the rules are written here: `*`
// matches any characters except `/`, `**` matches any characters including `/`, a
// leading `**/` (and a `/**/` segment) also matches zero directories, and the pattern
// matches the whole path from the repository root.
function matchesPathFilter(pattern, path) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern.startsWith('**/', index)) {
      source += '(?:[^/]+/)*';
      index += 2;
    } else if (pattern.startsWith('**', index)) {
      source += '.*';
      index += 1;
    } else if (pattern[index] === '*') {
      source += '[^/]*';
    } else {
      source += pattern[index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`).test(path);
}

/** The top-level `on:` block, ending at the next column-zero mapping key. */
function onSection(workflow) {
  const match = /^on:\n/m.exec(workflow);
  assert.ok(match, 'the workflow must declare a top-level `on:` block');
  const rest = workflow.slice(match.index + match[0].length);
  const next = rest.search(/^[a-z][a-z0-9-]*:\n/m);
  return rest.slice(0, next < 0 ? undefined : next);
}

/** Trigger names declared directly under `on:`. */
function triggers(workflow) {
  return [...onSection(workflow).matchAll(/^ {2}([a-z_]+):$/gm)].map((match) => match[1]);
}

/** Job ids declared under `jobs:`, in file order. */
function jobNames(workflow) {
  const marker = '\njobs:\n';
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, 'the workflow must declare a top-level `jobs:` block');
  return [...workflow.slice(start + marker.length).matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)]
    .map((match) => match[1]);
}

/** One job's text, from its two-space `id:` line to the next two-space key. */
function jobSection(workflow, name) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) return '';
  const rest = workflow.slice(start + marker.length);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return marker + (next < 0 ? rest : rest.slice(0, next));
}

/** One `workflow_dispatch.inputs` entry, from its six-space `name:` line. */
function inputBlock(workflow, name) {
  const marker = `\n      ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, `${name} must be a workflow input`);
  const rest = workflow.slice(start + marker.length);
  const next = rest.search(/\n {6}[a-z0-9_]+:\n/);
  return rest.slice(0, next < 0 ? undefined : next);
}

/** One `steps:` entry, from its six-space `- name:` line to the next step. */
function stepSection(workflow, name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, `the workflow must declare the ${name} step`);
  const rest = workflow.slice(start + marker.length);
  const next = rest.search(/\n {6}- /);
  return marker + (next < 0 ? rest : rest.slice(0, next));
}

/**
 * The `{ ... }` block that follows `header`, matched by brace depth. The Android
 * build script is Kotlin, so its signing configuration is read as the nested block
 * it is rather than with a regular expression that would stop at the first `}`.
 */
function braceBlock(text, header) {
  const start = text.indexOf(header);
  assert.ok(start >= 0, `the Android build script must declare \`${header}\``);
  let depth = 0;
  for (let index = text.indexOf('{', start); index >= 0 && index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced braces after \`${header}\``);
}

/** The top-level `env:` block, ending at the next column-zero mapping key. */
function envSection(workflow) {
  const match = /^env:\n/m.exec(workflow);
  assert.ok(match, 'the workflow must declare a top-level `env:` block');
  const rest = workflow.slice(match.index + match[0].length);
  const next = rest.search(/^[a-z][a-z0-9-]*:\n/m);
  return rest.slice(0, next < 0 ? undefined : next);
}

test('the workflow directory contains exactly the seven repository workflows', () => {
  assert.deepEqual(workflowFiles, [
    'browser.yml',
    'build.yml',
    'check.yml',
    'client-release.yml',
    'release.yml',
    'tauri-smoke.yml',
    'test.yml',
  ]);
});

test('the repository exposes exactly three entries, one per trigger class', () => {
  // An entry is a workflow with a repository event or a dispatch surface. Everything
  // else must be a called workflow, which has no entry identity of its own.
  const entries = workflowFiles.filter((name) => {
    const declared = triggers(read(name));
    return declared.some((trigger) => trigger === 'push' || trigger === 'pull_request' || trigger === 'workflow_dispatch');
  });
  assert.deepEqual(entries, [automaticEntry, tagEntry, manualEntry]);

  // The three classes are mutually exclusive and each is carried by exactly one
  // workflow: `check.yml` is the only pull-request entry, `release.yml` the only
  // manual dispatch surface, and `client-release.yml` the only tag entry (a tag
  // trigger with no branch filter).
  const isTagEntry = (name) => {
    const on = onSection(read(name));
    return /^ {4}tags:/m.test(on) && !/^ {4}branches:/m.test(on);
  };
  assert.deepEqual(workflowFiles.filter((name) => triggers(read(name)).includes('pull_request')), [automaticEntry]);
  assert.deepEqual(workflowFiles.filter((name) => triggers(read(name)).includes('workflow_dispatch')), [manualEntry]);
  assert.deepEqual(workflowFiles.filter(isTagEntry), [tagEntry]);
  for (const name of entries) {
    const classes = [
      triggers(read(name)).includes('pull_request'),
      triggers(read(name)).includes('workflow_dispatch'),
      isTagEntry(name),
    ].filter(Boolean).length;
    assert.equal(classes, 1, `${name} must belong to exactly one trigger class`);
  }

  // `check.yml` stays the only automatic check: it is the only workflow that runs on
  // pull requests, and the only one whose push event is a check rather than a
  // publication tag.
  const checks = workflowFiles.filter((name) => triggers(read(name)).includes('pull_request'));
  assert.deepEqual(checks, [automaticEntry]);
  assert.deepEqual(triggers(read(automaticEntry)).sort(), ['pull_request', 'push']);

  for (const name of calledWorkflows) {
    assert.deepEqual(triggers(read(name)), ['workflow_call'], `${name} is a called workflow, not an entry`);
  }
});

test('the publication entry runs on a merge to main as well as on a manual dispatch', () => {
  const release = read(manualEntry);
  assert.ok(release.includes(PATHS_IGNORE_DECLARATION), 'release.yml must carry the #268 declaration verbatim');
  assert.deepEqual(triggers(release).sort(), ['push', 'workflow_dispatch']);
  assert.match(onSection(release), /^ {2}push:\n {4}branches: \[main\]$/m);
  assert.match(onSection(release), /^ {2}workflow_dispatch:$/m);

  const check = read(automaticEntry);
  assert.doesNotMatch(check, /workflow_dispatch/, 'the automatic check has no dispatch surface');
});

// #268: a merge whose changed files are all Markdown starts no publication, because
// every changed path matches `paths-ignore`; one file outside the list still starts
// the whole five-job chain. Both directions are evaluated with a matcher written to
// GitHub's documented `*`/`**` rules, not with `path.matchesGlob`.
test('a documentation-only merge starts nothing while a mixed merge starts the publication', () => {
  // The matcher is self-checked against the documented cheat sheet before it evaluates
  // the declaration, so a broken matcher cannot pass by agreeing with itself.
  for (const [pattern, path, expected] of [
    ['**.js', 'index.js', true],
    ['**.js', 'js/index.js', true],
    ['**.js', 'src/js/app.js', true],
    ['**/README.md', 'README.md', true],
    ['**/README.md', 'js/README.md', true],
    ['**/*-post.md', 'my-post.md', true],
    ['docs/**/*.md', 'docs/mona/hello-world.md', true],
    ['docs/**/*.md', 'src/README.md', false],
  ]) {
    assert.equal(matchesPathFilter(pattern, path), expected, `matcher self-check: '${pattern}' against '${path}'`);
  }

  const release = read(manualEntry);
  assert.ok(release.includes(PATHS_IGNORE_DECLARATION), 'release.yml must carry the #268 declaration verbatim');
  assert.match(
    release,
    /^ {2}push:\n {4}branches: \[main\]\n {4}paths-ignore:\n {6}- '\*\*\/\*\.md'$/m,
    'the push trigger keeps `branches: [main]` and excludes the documentation set',
  );
  assert.doesNotMatch(release, /^ {4}paths:/m, 'the push trigger excludes with `paths-ignore`, not with an allowlist');

  // The list is read back from the workflow text, so the evaluation covers what the
  // repository actually declares rather than a copy of it.
  const pushStart = release.indexOf('\n  push:\n');
  assert.ok(pushStart >= 0, 'release.yml must declare a `push` trigger');
  const afterPush = release.slice(pushStart + '\n  push:\n'.length);
  const nextTrigger = afterPush.search(/^ {2}[a-z_]+:\n/m);
  const push = afterPush.slice(0, nextTrigger < 0 ? undefined : nextTrigger);
  const declared = [...push.matchAll(/^ {6}- '([^']+)'$/gm)].map((match) => match[1]);
  assert.deepEqual(declared, ['**/*.md'], 'the declared `paths-ignore` list is exactly the one Markdown pattern');

  // `paths-ignore` semantics: skipped only when every changed path matches.
  const skips = (paths) => paths.every((path) => declared.some((pattern) => matchesPathFilter(pattern, path)));

  assert.ok(skips(['README.md']), 'a documentation-only merge starts nothing');
  assert.ok(skips(['docs/beta-web-publication.md', 'AGENTS.md']), 'a documentation-only merge of several files starts nothing');
  assert.ok(!skips(['README.md', 'src/main.tsx']), 'one source file beside a document still starts the publication');
  assert.ok(!skips(['index.html']), 'a product input outside the list still starts the publication');
  assert.ok(!skips(['.github/workflows/release.yml']), 'a workflow change still starts the publication');
  assert.ok(!skips(['.github/scripts/assert-client-publication.mjs']), 'a script outside the list still starts the publication');

  // The filter is the only trigger change: the five jobs and the dispatch menu stay.
  assert.deepEqual(jobNames(release), ['build', 'verify', 'deploy', 'record', 'handoff']);
  assert.deepEqual(triggers(release), ['push', 'workflow_dispatch']);
  const operation = inputBlock(release, 'operation');
  assert.match(operation, /^ {8}type: choice$/m);
  assert.match(operation, /^ {8}options: \[deploy\]$/m);
});

test('the dispatch surface is exactly one workflow, release.yml', () => {
  const manual = workflowFiles.filter((name) => triggers(read(name)).includes('workflow_dispatch'));
  assert.deepEqual(manual, [manualEntry]);
  assert.equal([...read(manualEntry).matchAll(/^ {2}workflow_dispatch:$/gm)].length, 1);
});

test('release.yml offers exactly one required choice operation: deploy', () => {
  const release = read(manualEntry);
  const operation = inputBlock(release, 'operation');
  assert.match(operation, /^ {8}type: choice$/m);
  assert.match(operation, /^ {8}required: true$/m);
  assert.match(operation, /^ {8}options: \[deploy\]$/m);
});

test('only deploy holds an environment and an OIDC token, after verify, with credential-free record and handoff', () => {
  const release = read(manualEntry);
  const names = jobNames(release);
  assert.deepEqual(names, ['build', 'verify', 'deploy', 'record', 'handoff']);

  const sections = Object.fromEntries(names.map((name) => {
    const section = jobSection(release, name);
    assert.ok(section.length > 0, `release.yml must declare the ${name} job`);
    return [name, section];
  }));

  // The credential boundary is a single job, and it is the last one before recording.
  assert.deepEqual(names.filter((name) => /^ {4}environment:/m.test(sections[name])), ['deploy']);
  assert.deepEqual(names.filter((name) => /^ {6}id-token: write$/m.test(sections[name])), ['deploy']);
  assert.deepEqual(names.filter((name) => /configure-aws-credentials/.test(sections[name])), ['deploy']);
  for (const name of ['build', 'verify', 'record', 'handoff']) {
    assert.doesNotMatch(sections[name], /^ {4}environment:/m, `${name} must not declare an environment`);
    assert.doesNotMatch(sections[name], /id-token/, `${name} must not declare an OIDC token`);
    assert.doesNotMatch(sections[name], /configure-aws-credentials/, `${name} must not acquire AWS credentials`);
  }

  assert.match(sections.deploy, /^ {4}environment: beta$/m);
  assert.match(sections.deploy, /^ {6}id-token: write$/m);
  assert.match(sections.deploy, /^ {4}needs: \[verify\]$/m);

  // The chain order is explicit: build -> verify -> deploy -> record -> handoff.
  assert.doesNotMatch(sections.build, /^ {4}needs:/m, 'build is the first job of the chain');
  assert.match(sections.verify, /^ {4}needs: \[build\]$/m);
  assert.match(sections.record, /^ {4}needs: \[deploy\]$/m);
  assert.match(sections.handoff, /^ {4}needs: \[record\]$/m);
  assert.ok(names.indexOf('verify') < names.indexOf('deploy'));
  assert.ok(names.indexOf('deploy') < names.indexOf('record'));
  assert.ok(names.indexOf('record') < names.indexOf('handoff'));

  // record and handoff record and dispatch; neither holds a permission beyond
  // reading the repository.
  for (const name of ['record', 'handoff']) {
    const permissions = /^ {4}permissions:\n((?: {6}[a-z0-9-]+: [a-z]+(?:\n|$))+)/m.exec(sections[name])?.[1];
    assert.equal(permissions, '      contents: read\n', `${name} must hold only \`contents: read\``);
  }
});

test('the only activation switch in any workflow is ENABLE_BETA_MUTATION', () => {
  const names = new Set();
  for (const name of workflowFiles) {
    for (const match of read(name).matchAll(/\bENABLE_[A-Z0-9_]+\b/g)) names.add(match[0]);
  }
  assert.deepEqual([...names], ['ENABLE_BETA_MUTATION']);

  const release = read(manualEntry);
  assert.match(release, /vars\.ENABLE_BETA_MUTATION/);
  for (const name of workflowFiles.filter((candidate) => candidate !== manualEntry)) {
    assert.doesNotMatch(read(name), /\bENABLE_[A-Z0-9_]+\b/, `${name} must not declare an activation switch`);
  }
});

test('check.yml wires the four called workflows and maps the App secret only on build', () => {
  const check = read(automaticEntry);
  assert.deepEqual(jobNames(check), ['build', 'test', 'tauri-smoke', 'browser']);

  const build = jobSection(check, 'build');
  const unitTest = jobSection(check, 'test');
  const desktopSmoke = jobSection(check, 'tauri-smoke');
  const browser = jobSection(check, 'browser');
  for (const [name, section] of [['build', build], ['test', unitTest], ['tauri-smoke', desktopSmoke], ['browser', browser]]) {
    assert.ok(section.length > 0, `check.yml must declare the ${name} job`);
  }

  assert.match(build, /^ {4}uses: \.\/\.github\/workflows\/build\.yml$/m);
  assert.match(build, /^ {4}secrets:\n {6}APP_PRIVATE_KEY: \$\{\{ secrets\.APP_PRIVATE_KEY \}\}$/m);
  assert.doesNotMatch(build, /secrets: inherit/);

  assert.match(unitTest, /^ {4}needs: \[build\]$/m);
  assert.match(unitTest, /^ {4}uses: \.\/\.github\/workflows\/test\.yml$/m);
  assert.doesNotMatch(unitTest, /secrets:/);

  assert.match(desktopSmoke, /^ {4}needs: \[test\]$/m);
  assert.match(desktopSmoke, /^ {4}uses: \.\/\.github\/workflows\/tauri-smoke\.yml$/m);
  assert.doesNotMatch(desktopSmoke, /secrets:/);

  assert.match(browser, /^ {4}needs: \[test\]$/m);
  assert.match(browser, /^ {4}uses: \.\/\.github\/workflows\/browser\.yml$/m);
  assert.doesNotMatch(browser, /secrets:/);
});

// #188: the deploy job resolves the whole live interface from the Beta `Base`
// stack, which owns both CloudFront distributions and the `ApiBaseUrl` output.
// The retired workload stack read was denied and left the publish with no asset
// sync, no invalidation and no publication record.
test('#188: the deploy job reads the Beta Base stack only and resolves its interface', () => {
  const release = read(manualEntry);
  // Assembled from its parts so this guard does not itself defeat the issue's
  // repository-wide census that the retired stack name has zero occurrences.
  const retiredStack = ['AnyWearWorkloadStack', 'beta'].join('-');
  assert.ok(!release.includes(retiredStack), 'the deploy path must not name the retired stack');

  const settings = stepSection(release, 'Resolve Beta deployment settings');
  assert.deepEqual(
    [...settings.matchAll(/--stack-name\s+(\S+)/g)].map((match) => match[1]),
    ['AnyWearPlatformStack-beta'],
    'the settings step reads exactly the Beta Base stack',
  );
  assert.match(settings, /require_output ApiBaseUrl|select\(\.OutputKey == "ApiBaseUrl"\)/);
  assert.match(settings, /\/anywear\/beta\/cognito_user_pool_id/);
  assert.match(settings, /\/anywear\/beta\/cognito_client_id/);
  assert.equal([...settings.matchAll(/aws ssm get-parameter/g)].length, 2);
  for (const output of ['bucket', 'distribution', 'api_url', 'pool_id', 'client_id']) {
    assert.ok(
      settings.includes(`echo "${output}=$${output}"`),
      `${output} leaves the settings step as a step output`,
    );
  }
  assert.match(settings, /\} >> "\$GITHUB_OUTPUT"/);
});

// #226: a merge publishes the same interface the manual dispatch used to type. The
// three values are reviewed workflow constants, and each job reads the dispatch
// override or the constant, so a push needs no input and a manual dispatch behaves
// exactly as before.
test('#226: the reviewed Beta interface is a workflow constant the build compiles', () => {
  const release = read(manualEntry);
  assert.deepEqual(
    Object.fromEntries([...envSection(release).matchAll(/^ {2}([A-Z0-9_]+): '([^']*)'$/gm)].map((match) => [match[1], match[2]])),
    {
      BETA_API_BASE_URL: 'https://d1pfqujqt29n11.cloudfront.net',
      BETA_COGNITO_USER_POOL_ID: 'ap-east-1_XqXt4Kw1L',
      BETA_COGNITO_CLIENT_ID: '4jp37atfitq59hmjo404342int',
    },
  );

  const reads = {
    BETA_API_BASE_URL: 'api_base_url',
    BETA_COGNITO_USER_POOL_ID: 'cognito_user_pool_id',
    BETA_COGNITO_CLIENT_ID: 'cognito_client_id',
  };
  const build = stepSection(release, 'Build Beta web client');
  for (const [constant, input] of Object.entries(reads)) {
    const expression = new RegExp(`^ {10}VITE_${constant.replace('BETA_', '')}: \\$\\{\\{ inputs\\.${input} \\|\\| env\\.${constant} \\}\\}$`, 'm');
    assert.match(build, expression, `build must compile the ${constant} constant when no input is given`);
  }

  const verify = stepSection(release, 'Validate publication identity and declared interface');
  for (const [constant, input] of Object.entries(reads)) {
    const expression = new RegExp(`^ {10}DECLARED_${constant.replace('BETA_', '')}: \\$\\{\\{ inputs\\.${input} \\|\\| env\\.${constant} \\}\\}$`, 'm');
    assert.match(verify, expression, `verify must compare the same interface a push compiled`);
  }

  // `deploy` re-checks the declared interface before its first AWS write.
  assert.match(
    jobSection(release, 'deploy'),
    /^ {10}DECLARED_API_BASE_URL: \$\{\{ inputs\.api_base_url \|\| env\.BETA_API_BASE_URL \}\}$/m,
  );

  // The interface is not repository configuration: changing a value is a reviewed
  // change to this workflow, not an owner setting the run cannot see.
  assert.doesNotMatch(release, /vars\.(?:BETA_|API_BASE_URL|COGNITO_)/);
});

test('#226: deploy still refuses a live interface that differs before the first S3 write', () => {
  const deploy = jobSection(read(manualEntry), 'deploy');
  const refusal = deploy.indexOf('      - name: Refuse a live interface that differs from the built interface\n');
  const publish = deploy.indexOf('      - name: Publish static assets\n');
  assert.ok(refusal >= 0, 'deploy must keep the live-interface refusal step');
  assert.ok(publish >= 0, 'deploy must keep the publish step');
  assert.ok(refusal < publish, 'the refusal must run before the first S3 write');
  assert.match(
    stepSection(deploy, 'Refuse a live interface that differs from the built interface'),
    /^ {8}run: node \.github\/scripts\/assert-client-publication\.mjs deploy$/m,
  );
});

test('#226: the handoff dispatches exactly one deploy-smoke and has no step after it', () => {
  const handoff = jobSection(read(manualEntry), 'handoff');
  assert.deepEqual(
    [...handoff.matchAll(/^ {6}- name: (.+)$/gm)].map((match) => match[1]),
    [
      'Mint the AnyWear-E2E dispatch token',
      'Check for a smoke run already queued for this publication',
      'Dispatch the post-publication smoke',
    ],
    'the dispatch is the last step',
  );

  // One App token, narrowed to the E2E repository with `actions: write` only.
  const token = stepSection(handoff, 'Mint the AnyWear-E2E dispatch token');
  assert.match(token, /^ {10}repositories: AnyWear-E2E$/m);
  assert.match(token, /^ {10}permission-actions: write$/m);
  assert.match(
    handoff,
    /^ {6}DISPATCHED_BY: \$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}\/actions\/runs\/\$\{\{ github\.run_id \}\}$/m,
  );

  // The dedupe lists this workflow's queued and in-progress runs and skips when this
  // run's URL already appears in one; a failed listing dispatches anyway.
  const dedupe = stepSection(handoff, 'Check for a smoke run already queued for this publication');
  assert.match(dedupe, /for status in queued in_progress; do/);
  assert.match(dedupe, /repos\/\$\{E2E_OWNER\}\/\$\{E2E_REPOSITORY\}\/actions\/workflows\/\$\{E2E_WORKFLOW\}\/runs\?status=\$\{status\}/);
  assert.match(dedupe, /Skipping the smoke dispatch/);
  assert.match(dedupe, /dispatching the smoke anyway/);

  // The payload is exactly the four fields, `dispatched_by` is this run's URL, and no
  // expected commit is sent. `gh workflow run` cannot return the run, so the REST
  // endpoint is called with `return_run_details`.
  const dispatch = stepSection(handoff, 'Dispatch the post-publication smoke');
  assert.match(dispatch, /repos\/\$\{E2E_OWNER\}\/\$\{E2E_REPOSITORY\}\/actions\/workflows\/\$\{E2E_WORKFLOW\}\/dispatches/);
  assert.match(dispatch, /-F return_run_details=true/);
  assert.match(dispatch, /-f 'inputs\[operation\]=smoke'/);
  assert.match(dispatch, /-f 'inputs\[trigger\]=deploy-smoke'/);
  assert.match(dispatch, /-f 'inputs\[worker_slot_offset\]=0'/);
  assert.match(dispatch, /-f "inputs\[dispatched_by\]=\$\{DISPATCHED_BY\}"/);
  assert.doesNotMatch(dispatch, /expected_/);

  // #226: the dispatch response names the run it created, so the normal path verifies
  // that run by id with one read and no polling. The run title renders after the run
  // appears, so a check that reads it immediately failed in production for a run that
  // existed; the title is read only inside the bounded fallback branch.
  assert.match(dispatch, /run_id="\$\(jq -r '\.workflow_run_id \/\/ empty' <<< "\$response"\)"/);
  assert.match(dispatch, /run_url="\$\(jq -r '\.html_url \/\/ \.run_url \/\/ empty' <<< "\$response"\)"/);

  const fallbackMarker = 'Fallback only when the response carries no `workflow_run_id`';
  const fallbackStart = dispatch.indexOf(fallbackMarker);
  assert.ok(fallbackStart > 0, 'the dispatch step must keep the fallback branch for a response carrying no run id');

  const byId = dispatch.slice(0, fallbackStart);
  assert.match(byId, /^ {10}if \[ -n "\$run_id" \]; then$/m, 'the by-id path is the normal path, taken when the response carries the id');
  assert.match(byId, /actions\/runs\/\$\{run_id\}" --jq '\.id'/);
  assert.match(byId, /\[ "\$created_id" != "\$run_id" \]/, 'the created run id must equal the dispatched id');
  assert.doesNotMatch(byId, /display_title/, 'the normal path must not read the run title');
  assert.doesNotMatch(byId, /sleep/, 'the normal path must not poll');

  // The fallback is a bounded poll: a finite attempt count, a wait between attempts,
  // and a failure only after the attempts are exhausted.
  const fallback = dispatch.slice(fallbackStart);
  assert.match(fallback, /display_title/, 'only the fallback reads the run title');
  assert.match(fallback, /attempts=\d+/);
  assert.match(fallback, /for attempt in \$\(seq 1 "\$attempts"\)/);
  assert.match(fallback, /sleep "\$wait_seconds"/);
  assert.match(fallback, /if \[ "\$attempt" -lt "\$attempts" \]/);
  assert.match(fallback, /\[ -z "\$run_url" \]/);
  assert.match(fallback, /appeared in \$\{attempts\} attempts/);
});

// #226: `verify` runs `pnpm run test:run`, which includes the ambient case in
// `assert-client-version-bump.node-test.mjs`: it calls the real checker with the CI
// environment, and under the `push` trigger the checker resolves `github.event.before`
// from the event payload and reads that commit from this checkout. A depth-1 checkout
// does not contain the revision, so the ambient check fails on a merge with an
// unresolvable base even when the version history itself satisfies the rule. Give
// `verify` the history the check resolves.
test('#226: the verify checkout fetches the history the version-bump check reads', () => {
  const release = read(manualEntry);
  const verify = jobSection(release, 'verify');
  assert.match(verify, /^ {8}run: pnpm run test:run$/m, 'verify must keep running the suite that holds the bump check');

  const checkout = stepSection(verify, 'Checkout');
  assert.match(checkout, /^ {10}fetch-depth: 0$/m, 'the verify checkout must fetch the full history, or the push base revision is absent');
  // `2` is the minimum for a single-commit push and fails for a multi-commit push or
  // a merge commit, and any shallower-than-full fetch can miss the before revision.
  assert.doesNotMatch(checkout, /^ {10}fetch-depth: [1-9]\d*$/m);

  // The called test workflow fetches the same way, for the same check.
  assert.match(stepSection(read('test.yml'), 'Checkout'), /^ {10}fetch-depth: 0$/m);
});

/** The job-level `permissions:` grants of one job section, as `name: level` lines. */
function jobPermissions(section) {
  const match = /^ {4}permissions:\n((?: {6}[a-z0-9-]+: [a-z]+(?:\n|$))+)/m.exec(section);
  if (!match) return [];
  return match[1].trim().split('\n').map((line) => line.trim());
}

// #278: the Client binary publication entry. The contract below is the issue's
// acceptance list read as source: a tag-only trigger, seven jobs in order, one
// release write and one attestation site, no cloud credential, every install
// locked, sibling platform jobs, fail-closed credentials naming the missing
// secret, signature verification on each platform, one checksum-derived
// attestation, and a draft-then-flip publication that never clobbers and never
// deletes a release.
test('#278: client-release.yml is the tag-only binary publication entry', () => {
  const workflow = read(tagEntry);
  assert.deepEqual(triggers(workflow), ['push']);
  assert.match(onSection(workflow), /^ {2}push:\n {4}tags: \['client-v\[0-9\]\*'\]$/m);
  assert.doesNotMatch(onSection(workflow), /workflow_dispatch|branches:|paths-ignore|paths:/);
  // GitHub does not evaluate path filters on a tag push, so none may be declared.
  assert.doesNotMatch(workflow, /paths-ignore/);
  assert.deepEqual(jobNames(workflow), [
    'preflight',
    'verify',
    'package-windows',
    'package-macos',
    'package-android',
    'assemble',
    'publish',
  ]);
});

test('#278: client-release.yml keeps one release write and one attestation site', () => {
  const workflow = read(tagEntry);
  const names = jobNames(workflow);
  const sections = Object.fromEntries(names.map((name) => [name, jobSection(workflow, name)]));

  assert.equal(
    /^permissions:\n((?: {2}[a-z0-9-]+: [a-z]+(?:\n|$))+)/m.exec(workflow)?.[1],
    '  contents: read\n',
    'the workflow-level permission is exactly read-only contents',
  );

  const grants = Object.fromEntries(names.map((name) => [name, jobPermissions(sections[name])]));
  assert.deepEqual(names.filter((name) => grants[name].includes('contents: write')), ['publish'], 'publish is the only release writer');
  assert.deepEqual(names.filter((name) => grants[name].includes('id-token: write')), ['assemble'], 'assemble is the only OIDC holder');
  assert.deepEqual(names.filter((name) => grants[name].includes('attestations: write')), ['assemble'], 'assemble is the only attestation writer');
  assert.doesNotMatch(workflow, /artifact-metadata/, 'container-image metadata permission is not part of this boundary');
});

test('#278: client-release.yml holds no AWS credential, environment or switch', () => {
  const workflow = read(tagEntry);
  assert.doesNotMatch(workflow, /^ {4}environment:/m, 'no job declares an environment');
  assert.doesNotMatch(workflow, /configure-aws-credentials/);
  assert.doesNotMatch(workflow, /secrets: inherit/);
  assert.doesNotMatch(workflow, /\baws\b/, 'no step runs the AWS CLI');
  assert.doesNotMatch(workflow, /\bENABLE_[A-Z0-9_]+\b/, 'the binary publication has no activation switch');
  // `preflight` calculates the declared platform list; it never reads a secret, so
  // missing signing credentials surface in the platform job that needs them.
  assert.doesNotMatch(jobSection(workflow, 'preflight'), /secrets\./);
});

test('#278: client-release.yml installs from the lockfile in every installing job', () => {
  const workflow = read(tagEntry);
  assert.deepEqual(
    [...workflow.matchAll(/^ {8}run: pnpm install.*$/gm)].map((match) => match[0]),
    [
      '        run: pnpm install --frozen-lockfile',
      '        run: pnpm install --frozen-lockfile',
      '        run: pnpm install --frozen-lockfile',
      '        run: pnpm install --frozen-lockfile',
    ],
    'verify and the three package jobs install exactly the committed lockfile',
  );
  assert.doesNotMatch(workflow, /--no-frozen-lockfile/);
  assert.doesNotMatch(workflow, /pnpm install(?! --frozen-lockfile)/, 'a bare `pnpm install` is not allowed');
});

test('#278: client-release.yml keeps the three platform jobs independent', () => {
  const workflow = read(tagEntry);
  const platformJobs = ['package-windows', 'package-macos', 'package-android'];
  for (const name of platformJobs) {
    const section = jobSection(workflow, name);
    assert.match(section, /^ {4}needs: \[preflight\]$/m, `${name} depends on preflight only`);
    assert.doesNotMatch(section, /^ {4}strategy:/m, `${name} is a job, not a matrix member`);
    for (const other of platformJobs.filter((candidate) => candidate !== name)) {
      assert.ok(!section.includes(other), `${name} must not reference ${other}`);
    }
  }
  assert.match(
    jobSection(workflow, 'assemble'),
    /^ {4}needs: \[preflight, verify, package-windows, package-macos, package-android\]$/m,
    'assemble is the first job that waits for every platform',
  );
});

test('#278: client-release.yml fails closed with the named platform credential error', () => {
  const workflow = read(tagEntry);
  const sites = {
    'package-windows': {
      platform: 'windows',
      secrets: ['WINDOWS_CERTIFICATE', 'WINDOWS_CERTIFICATE_PASSWORD'],
      step: 'Require the Windows signing credentials',
    },
    'package-macos': {
      platform: 'macos',
      secrets: ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_API_KEY_P8'],
      step: 'Require the macOS signing credentials',
    },
    'package-android': {
      platform: 'android',
      secrets: ['ANDROID_KEY_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'],
      step: 'Require the Android signing credentials',
    },
  };
  for (const [job, site] of Object.entries(sites)) {
    const section = jobSection(workflow, job);
    assert.equal(
      [...section.matchAll(/^ {6}- name: (.+)$/gm)][0]?.[1],
      site.step,
      `${job} must check its credentials before anything else`,
    );
    const credentialStep = stepSection(section, site.step);
    for (const secret of site.secrets) {
      assert.match(credentialStep, new RegExp(`\\$\\{\\{ secrets\\.${secret} \\}\\}`), `${credentialStep.split('\n')[0]} must read ${secret}`);
    }
    const article = 'a';
    assert.ok(
      credentialStep.includes(`is not configured; ${article} ${site.platform} release artifact cannot be produced`),
      `${job} must fail with the named ${site.platform} message`,
    );
  }
});

test('#278: client-release.yml verifies every signature before assembly', () => {
  const workflow = read(tagEntry);
  const windows = stepSection(jobSection(workflow, 'package-windows'), 'Verify the Windows signature');
  assert.match(windows, /Get-AuthenticodeSignature/);
  assert.match(windows, /\.Status -ne 'Valid'/);

  const macOS = stepSection(jobSection(workflow, 'package-macos'), 'Verify the macOS signature');
  assert.match(macOS, /codesign -vvv --strict/);
  assert.match(macOS, /spctl -a/);

  const android = stepSection(jobSection(workflow, 'package-android'), 'Verify the Android signatures');
  assert.match(android, /apksigner verify --print-certs/);
  // #290: the APK verifier is not on the runner's PATH and cannot read an AAB. The
  // step resolves the SDK and JDK tools by absolute path, verifies the APK with the
  // APK verifier and the bundle with the JAR verifier, and anchors both signer
  // certificates to the certificate of the keystore the job just materialized.
  assert.match(android, /build-tools/, 'apksigner must be resolved from the SDK build-tools');
  assert.match(android, /sort -V/, 'the newest build-tools version must win');
  assert.match(android, /jarsigner -verify/, 'the AAB must be verified with the JAR verifier');
  assert.match(android, /keytool -printcert -jarfile/, "the AAB's signer certificate must be read from the bundle");
  assert.match(android, /keytool -list -v -keystore/, 'the keystore certificate must be the expected signer');
  // #290 review: the keystore is JKS while `keytool` defaults to PKCS12, so the step
  // must read the type the materialize step detected and pass it to the keystore read.
  assert.match(android, /store_type=/, 'the keystore store type must be read from keystore.properties');
  assert.match(
    android,
    /keytool -list -v -keystore "\$keystore" -storetype "\$store_type"/,
    'the detected store type must be passed to keytool -list',
  );
  assert.match(android, /"\$apk_sha256" != "\$keystore_sha256"/, "the APK's fingerprint must be compared with the keystore's");
  assert.match(android, /"\$aab_sha256" != "\$keystore_sha256"/, "the AAB's fingerprint must be compared with the keystore's");
  assert.match(android, /the Android build produced no APK or no AAB/, 'the empty-artifact refusal must stay');
  assert.match(android, /grep -qE '\^jar verified\\\.\$'/, 'only the unqualified `jar verified.` line may pass the AAB check');
  // A bare `apksigner verify` cannot print the certificate the comparison needs, and
  // one verifier loop over both containers is the shape that fed the AAB to it.
  assert.doesNotMatch(android, /apksigner verify(?! --print-certs)/, 'apksigner must always print the signer certificate');
  assert.doesNotMatch(android, /for artifact in "\$\{apks\[@\]\}" "\$\{aabs\[@\]\}"/, 'each container must be verified by its own tool');
  // The code token, not the word in the step's comment: the SDK search must precede
  // the invocation it feeds.
  assert.ok(
    android.indexOf('"$root"/build-tools/') < android.indexOf('apksigner verify --print-certs'),
    'the build-tools search must run before apksigner is invoked',
  );
});

test('#278: client-release.yml carries the Android job contract', () => {
  const android = jobSection(read(tagEntry), 'package-android');
  assert.match(android, /^ {4}needs: \[preflight\]$/m);
  assert.match(android, /needs\.preflight\.outputs\.android == 'true'/);
  assert.match(android, /pnpm exec tauri android build --apk --aab/);
  assert.match(android, /apksigner verify --print-certs/);
  assert.match(android, /client-version\.json/);
  assert.match(android, /versionCode/);
  for (const secret of ['ANDROID_KEY_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD']) {
    assert.match(android, new RegExp(`secrets\\.${secret}\\b`), `package-android must declare ${secret}`);
  }
  assert.doesNotMatch(android, /tauri android init/, 'CI never initializes the Android project');

  // Technical Design §9 and ADR-0036 §8: the Rust Android targets are installed
  // before the build. `tauri android build` does not install them itself, so a
  // missing step would only fail when #279 first enables this leg.
  const targets = stepSection(android, 'Add the Android Rust targets');
  for (const target of ['aarch64-linux-android', 'armv7-linux-androideabi', 'i686-linux-android', 'x86_64-linux-android']) {
    assert.match(targets, new RegExp(`\\b${target}\\b`), `package-android must install ${target}`);
  }
  assert.ok(
    android.indexOf('Add the Android Rust targets') < android.indexOf('Build the signed Android packages'),
    'the Rust Android targets must be installed before the Android build',
  );
});

// #290: the committed Android project had no release signing configuration, so the
// first tagged Android build produced `app-universal-release-unsigned.apk` and the
// verification step had no signature to verify. The release build type is now signed
// from the properties file the pipeline materializes, and a checkout without that
// file still configures and builds unsigned for local work.
test('#290: the Android release build type is signed from the materialized keystore', () => {
  const gradle = readFileSync(join(repositoryRoot, 'src-tauri', 'gen', 'android', 'app', 'build.gradle.kts'), 'utf8');
  assert.match(
    gradle,
    /rootProject\.file\("keystore\.properties"\)/,
    'the build script must read the file the pipeline writes beside the gen/android project',
  );
  const signingConfigs = braceBlock(gradle, 'signingConfigs {');
  assert.match(signingConfigs, /create\("release"\)/, 'the script must create the release signing config');
  assert.match(
    signingConfigs,
    /storeFile = rootProject\.file\(keystoreProperties\.getProperty\("storeFile"\)\)/,
    'a relative storeFile must resolve beside the gen/android project, not inside app/',
  );
  for (const property of ['storePassword', 'keyAlias', 'keyPassword', 'storeType']) {
    assert.match(
      signingConfigs,
      new RegExp(`${property} = keystoreProperties\\.getProperty\\("${property}"\\)`),
      `the release signing config must read ${property}`,
    );
  }
  assert.match(
    signingConfigs,
    /if \(keystorePropertiesFile\.exists\(\)\)/,
    'a developer checkout without the file must still configure',
  );
  const release = braceBlock(gradle, 'getByName("release")');
  assert.match(
    release,
    /signingConfig = signingConfigs\.getByName\("release"\)/,
    'the release build type must use the release signing config',
  );
  // #290 review: the assignment must sit inside the existence guard, not merely
  // appear somewhere in the file, or a checkout without the file fails to configure.
  assert.match(
    braceBlock(release, 'if (keystorePropertiesFile.exists())'),
    /signingConfig = signingConfigs\.getByName\("release"\)/,
    'the signing config must be assigned inside the exists() guard',
  );

  // The file the build script reads is the one this step writes, and its storeFile is
  // absolute so Gradle cannot resolve it against the app module instead.
  const materialize = stepSection(jobSection(read(tagEntry), 'package-android'), 'Materialize the Android keystore');
  assert.match(
    materialize,
    /^ {12}echo "storeFile=\$\(pwd\)\/src-tauri\/gen\/android\/anywear-release\.jks"$/m,
    'the materialized storeFile must be absolute and name gen/android/anywear-release.jks',
  );
  for (const property of ['storePassword', 'keyAlias', 'keyPassword']) {
    assert.match(
      materialize,
      new RegExp(`^ {12}echo "${property}=\\$ANDROID_`, 'm'),
      `the materialized properties must carry ${property}`,
    );
  }
  // #290 review: JKS and PKCS12 are indistinguishable to both tools' defaults, so the
  // type is detected from the file magic and written for both consumers.
  assert.match(materialize, /od -An -tx1 -N4 "\$keystore"/, 'the store type must be detected from the keystore bytes');
  assert.match(materialize, /"feedfeed"/, 'a JKS keystore carries the FEED FEED magic');
  assert.match(
    materialize,
    /^ {12}echo "storeType=\$store_type"$/m,
    'the materialized properties must carry the detected storeType',
  );
});

test('#278: client-release.yml compares its assembled and uploaded inventories', () => {
  const workflow = read(tagEntry);
  const assemble = jobSection(workflow, 'assemble');
  // The declared platform list from preflight decides what must exist; deleting
  // either call leaves only the pure functions tested, not their wiring.
  assert.match(
    assemble,
    /node scripts\/assert-client-release\.mjs assets --version "\$RELEASE_VERSION" --platforms "\$DECLARED_PLATFORMS" --directory release-assets/,
    'assemble must compare its asset set with the declared platform list',
  );
  assert.match(
    assemble,
    /node scripts\/assert-client-release\.mjs sizes --directory release-assets/,
    'assemble must assert the 2 GiB single-file limit before upload',
  );

  const publish = jobSection(workflow, 'publish');
  assert.match(
    publish,
    /node scripts\/assert-client-release\.mjs inventory --tag "\$TAG" --view uploaded-release\.json --expect draft --platforms "\$DECLARED_PLATFORMS" --checksums release\/SHA256SUMS/,
    'publish must compare the uploaded draft with the declared platform list',
  );
  assert.match(
    publish,
    /node scripts\/assert-client-release\.mjs inventory --tag "\$TAG" --view published-release\.json --expect published --platforms "\$DECLARED_PLATFORMS" --checksums release\/SHA256SUMS/,
    'publish must compare the published readback with the same declared list',
  );
});

test('#278: client-release.yml proves the asset set with one checksum-derived attestation', () => {
  const workflow = read(tagEntry);
  const assemble = jobSection(workflow, 'assemble');
  assert.equal([...assemble.matchAll(/uses: actions\/attest@v4/g)].length, 1, 'exactly one attestation action');
  assert.match(assemble, /^ {10}subject-checksums: SHA256SUMS$/m);
  assert.match(assemble, /cp "\$\{\{ steps\.attest\.outputs\.bundle-path \}\}" SHA256SUMS\.sigstore\.json/);
  assert.doesNotMatch(workflow, /attest-build-provenance/);
  // Coreutils text mode, `LC_ALL=C sort`, and never the binary flag.
  assert.match(assemble, /sha256sum AnyWear-\* build-metadata\.json RELEASE-NOTES\.md \| LC_ALL=C sort > \.\.\/SHA256SUMS/);
  assert.doesNotMatch(assemble, /sha256sum -b/);
});

test('#278: client-release.yml declares the assemble condition over the declared set', () => {
  const assemble = jobSection(read(tagEntry), 'assemble');
  const condition = /^ {4}if: \$\{\{ ([\s\S]*?) \}\}$/m.exec(assemble)?.[1];
  assert.ok(condition, 'assemble must declare its condition');
  assert.equal(
    condition.replace(/\s+/g, ' ').trim(),
    "!cancelled() && needs.verify.result == 'success' "
    + "&& (needs.package-windows.result == 'success' || (needs.preflight.outputs.windows == 'false' && needs.package-windows.result == 'skipped')) "
    + "&& (needs.package-macos.result == 'success' || (needs.preflight.outputs.macos == 'false' && needs.package-macos.result == 'skipped')) "
    + "&& (needs.package-android.result == 'success' || (needs.preflight.outputs.android == 'false' && needs.package-android.result == 'skipped'))",
    'a declared platform that did not succeed must stop assembly, and only an undeclared one may be skipped',
  );
});

test('#278: client-release.yml wires every declared-set consumer to its own preflight output', () => {
  const workflow = read(tagEntry);
  const preflight = jobSection(workflow, 'preflight');
  const outputs = /^ {4}outputs:\n((?: {6}[a-z0-9-]+: .*\n)+)/m.exec(preflight)?.[1] ?? '';
  for (const output of ['version', 'platforms', 'windows', 'macos', 'android', 'state']) {
    assert.match(outputs, new RegExp(`^ {6}${output}: `, 'm'), `preflight must republish its ${output} output`);
  }

  // Each platform leg is gated on its own boolean, and never runs once preflight
  // classified a published release.
  for (const [job, platform] of [['package-windows', 'windows'], ['package-macos', 'macos'], ['package-android', 'android']]) {
    assert.match(
      jobSection(workflow, job),
      new RegExp(`^ {4}if: needs\\.preflight\\.outputs\\.state != 'published' && needs\\.preflight\\.outputs\\.${platform} == 'true'$`, 'm'),
      `${job} must run only when the configuration declares ${platform}`,
    );
  }

  const assemble = jobSection(workflow, 'assemble');
  // The three artifact downloads: only a declared leg's artifact exists.
  for (const [step, platform] of [['Download the Windows assets', 'windows'], ['Download the macOS assets', 'macos'], ['Download the Android assets', 'android']]) {
    assert.match(
      stepSection(assemble, step),
      new RegExp(`^ {8}if: needs\\.preflight\\.outputs\\.${platform} == 'true'$`, 'm'),
      `${step} must download only when ${platform} is declared`,
    );
  }

  // The four canonical copies: each is guarded by its own preflight boolean, and
  // Android's two share the Android boolean.
  const canonical = stepSection(assemble, 'Assemble the canonical assets');
  const guardedCopy = (flag) => {
    const start = canonical.indexOf(`if [ "$${flag}" = 'true' ]; then`);
    assert.ok(start >= 0, `the canonical copies must be guarded by the ${flag} boolean`);
    const end = canonical.indexOf('\n          fi', start);
    assert.ok(end > start, `the ${flag} guard must be closed`);
    return canonical.slice(start, end);
  };
  assert.match(
    guardedCopy('WINDOWS'),
    /cp artifacts\/windows\/windows-setup\.exe "release-assets\/AnyWear-\$\{RELEASE_VERSION\}-windows-x64-setup\.exe"/,
  );
  assert.match(
    guardedCopy('MACOS'),
    /cp artifacts\/macos\/macos-image\.dmg "release-assets\/AnyWear-\$\{RELEASE_VERSION\}-macos-universal\.dmg"/,
  );
  const androidCopies = guardedCopy('ANDROID');
  assert.match(androidCopies, /cp artifacts\/android\/android\.apk "release-assets\/AnyWear-\$\{RELEASE_VERSION\}-android\.apk"/);
  assert.match(androidCopies, /cp artifacts\/android\/android\.aab "release-assets\/AnyWear-\$\{RELEASE_VERSION\}-android\.aab"/);

  // The Android leg stages the fixed asset it now supplies for an Android-only set.
  assert.match(
    stepSection(jobSection(workflow, 'package-android'), 'Stage the Android assets'),
    /^ {10}cp dist\/build-metadata\.json release-assets\/build-metadata\.json$/m,
    'package-android must stage build-metadata.json',
  );

  // `build-metadata.json` comes from the first declared platform in canonical
  // order whose artifact carries one, is checked for existence, and is copied,
  // never minted.
  const select = stepSection(assemble, 'Select build-metadata.json');
  const windowsSource = select.indexOf('artifacts/windows/build-metadata.json');
  const macosSource = select.indexOf('artifacts/macos/build-metadata.json');
  const androidSource = select.indexOf('artifacts/android/build-metadata.json');
  assert.ok(
    windowsSource >= 0 && windowsSource < macosSource && macosSource < androidSource,
    'the build-metadata source must be chosen in canonical order: windows, then macos, then android',
  );
  for (const source of ['artifacts/windows', 'artifacts/macos', 'artifacts/android']) {
    assert.match(
      select,
      new RegExp(`\\[ -f ${source.replace(/\//g, '\\/')}\\/build-metadata\\.json \\]`),
      `the ${source} file must be checked for existence before it is chosen`,
    );
  }
  assert.match(select, /cp "\$source_path" release-assets\/build-metadata\.json/);
  assert.match(select, /::error::no declared platform staged build-metadata\.json/);
  assert.doesNotMatch(
    select,
    /> release-assets\/build-metadata\.json/,
    'assemble must never mint the fixed asset it publishes',
  );
  assert.doesNotMatch(
    assemble,
    /^\s+cp artifacts\/windows\/build-metadata\.json release-assets\/build-metadata\.json$/m,
    'build-metadata.json is no longer taken unconditionally from the Windows artifact',
  );
});

test('#278: client-release.yml creates a draft, verifies it, flips it and reads it back', () => {
  const workflow = read(tagEntry);
  const publish = jobSection(workflow, 'publish');
  assert.match(publish, /gh release create "\$TAG" --repo anywear-ai\/AnyWear-Client --verify-tag --draft --prerelease --latest=false/);
  assert.match(publish, /gh release upload "\$TAG"/);
  assert.match(publish, /sha256sum -c SHA256SUMS/);
  assert.match(publish, /gh release edit "\$TAG" --repo anywear-ai\/AnyWear-Client --draft=false --prerelease --latest=false/);
  assert.equal([...workflow.matchAll(/gh release edit/g)].length, 1, 'the flip is the only release edit');
  assert.doesNotMatch(workflow, /--clobber/);
  assert.equal([...workflow.matchAll(/isImmutable == true/g)].length, 0, 'the pipeline does not assert an administrator-only setting');
  assert.doesNotMatch(workflow, /git tag/, 'no workflow creates a tag');

  const readback = publish.indexOf('Verify the uploaded draft');
  const flip = publish.indexOf('gh release edit');
  assert.ok(readback >= 0 && flip > readback, 'the readback and checksum verification precede the flip');

  // A release object is never deleted: the only delete path is the draft-only
  // purge of an adopted draft's assets, and it is gated on the `draft` state.
  assert.doesNotMatch(workflow, /gh release delete/, 'no workflow deletes a release');
  const deletePaths = [...workflow.matchAll(/gh api\s+(?:-X|--method)[=\s]+DELETE\s+"?([^"\s]+)"?/g)].map((match) => match[1]);
  assert.deepEqual(
    deletePaths,
    ['repos/anywear-ai/AnyWear-Client/releases/assets/$asset_id'],
    'the only API delete is the draft asset purge, never a release object',
  );
  const adopt = stepSection(publish, 'Adopt the existing draft');
  assert.match(adopt, /^ {8}if: needs\.preflight\.outputs\.state == 'draft'$/m, 'the purge runs only against a draft');
  assert.match(adopt, /releases\/assets\/\$asset_id/);

  // The 90-day assembled bundle is named for the tag and the run, as §7 records.
  assert.equal(
    [...workflow.matchAll(/^ {10}name: client-release-\$\{\{ github\.ref_name \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}$/gm)].length,
    2,
    'the producer and the consumer name the same release bundle artifact',
  );
});

test('#278: both publication workflows carry the identical reviewed Beta constants', () => {
  const constants = (name) => ['BETA_API_BASE_URL', 'BETA_COGNITO_USER_POOL_ID', 'BETA_COGNITO_CLIENT_ID'].map((constant) => {
    const line = new RegExp(`^ {2}${constant}: '[^']*'$`, 'm').exec(read(name))?.[0];
    assert.ok(line, `${name} must declare ${constant} as a reviewed workflow constant`);
    return line;
  });
  assert.deepEqual(constants(tagEntry), constants(manualEntry), 'the two publication entries must compile the same interface');
});

test('#278: client-release.yml compiles the interface into every package job', () => {
  const workflow = read(tagEntry);
  for (const job of ['package-windows', 'package-macos', 'package-android']) {
    const section = jobSection(workflow, job);
    assert.match(section, /^ {10}VITE_API_BASE_URL: \$\{\{ env\.BETA_API_BASE_URL \}\}$/m, `${job} must compile the constants`);
    assert.match(section, /^ {10}VITE_COGNITO_USER_POOL_ID: \$\{\{ env\.BETA_COGNITO_USER_POOL_ID \}\}$/m, `${job} must compile the constants`);
    assert.match(section, /^ {10}VITE_COGNITO_CLIENT_ID: \$\{\{ env\.BETA_COGNITO_CLIENT_ID \}\}$/m, `${job} must compile the constants`);
  }
});
