import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// #354: the census over every workflow script of this repository that could read
// an Actions run by id. The class "a by-id read of a freshly created run must
// tolerate eventual consistency" has one implementation, `scripts/created-run-read.mjs`;
// this test fails when any tracked workflow script spells `actions/runs/` outside it,
// when the vendored bytes drift from the pinned SHA-256, when the retry policy is
// defined twice, when the module gains a dependency, or when the restricted
// `requireSuccess: false` flag appears anywhere but the handoff's read.
//
// The scan set is the one the Analysis records for this repository:
// `git ls-files .github scripts`, extensions mjs/cjs/js/ts/yml/yaml, without tests
// (`*.node-test.mjs`, so the guard cannot scan its own suite) and fixtures.
// Comments are stripped before the scan, so prose about a URL is not a read.
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const MODULE = 'scripts/created-run-read.mjs';
const HANDOFF = 'scripts/client-handoff.mjs';
const MODULE_PATH_LITERAL = 'repos/${repository}/actions/runs/${runId}';
const MODULE_TEMPLATE = `\`${MODULE_PATH_LITERAL}\``;
const SCAN_EXTENSIONS = /\.(?:mjs|cjs|js|ts|ya?ml)$/;
const SUB_RESOURCES = /\/(?:jobs|artifacts|attempts|logs|timing|cancel|rerun|force-cancel|approve|review)\b|\?per_page=/;
const BROWSABLE_HOST = /(?:https?:\/\/github\.com\/|github\\\.com\/|GITHUB_SERVER_URL|SERVER_URL|server_url|serverUrl)/;
// The repository segment on the left of `actions/runs/`, in the three spellings a
// browsable URL takes here: a workflow expression `${{ github.repository }}/`, a
// shell variable `${GITHUB_REPOSITORY}/`, and a literal `owner/repo/`. The doubled
// braces are deliberate: a GitHub Actions expression ends with `}}`, so a pattern
// that stopped at the first `}` would reject `release.yml:241`'s URL — which builds
// the host and the repository from `github.server_url`/`github.repository` and
// issues no request.
const REPOSITORY_SEGMENT = /(?:\$\{\{[^}]*\}\}|\$\{[^}]*\}|[\w.-]+\/[\w.-]+)\/$/;

// The Client carries no exemption row: every `actions/runs/` span in this
// repository's workflow scripts is the module's own template, a browsable URL or a
// sub-resource. The table stays (empty) so the classifier's exemption branch is
// exercised by the self-test below and a future row has to be added with a reason.
const EXEMPTIONS = Object.freeze({});

// The SHA-256 over the LF-normalised bytes of the canonical module
// `AnyWear-Infra/scripts/lib/created-run-read.mjs`, taken from AnyWear-Infra commit
// 6e8c2d94ad59623a118b748f2fc80a4157421c7a. AnyWear-Service and AnyWear-Client
// vendor these exact bytes and carry the same value; the reviewer and the
// independent verifier compare the three constants, because no repository's CI can
// read another private repository.
const PINNED_DIGEST = '78d6883547dc45df1bd57b0f698428b4592aca0b20cdc453dd2a2edc9419ba10';

const readText = file => readFileSync(path.join(repositoryRoot, file), 'utf8');
const trackedScanFiles = () => execFileSync('git', ['-C', repositoryRoot, 'ls-files', '.github', 'scripts'],
  { encoding: 'utf8' })
  .split(/\r?\n/).filter(Boolean)
  .map(file => file.split(path.sep).join('/'))
  .filter(file => SCAN_EXTENSIONS.test(file))
  .filter(file => !file.startsWith('test/') && !file.includes('/fixtures/') && !file.endsWith('.node-test.mjs'));

// Strip block comments (keeping newlines so line numbers survive) and line
// comments, without touching the `//` of a URL or a YAML value.
function stripComments(file, text) {
  const cleaned = text.replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' '));
  return cleaned.split('\n').map(line => (/\.ya?ml$/.test(file)
    ? line.replace(/(^|\s)#.*$/, '$1')
    : line.replace(/(^|[^:])\/\/.*$/, '$1'))).join('\n');
}

function occurrencesOf(file, text) {
  const found = [];
  text.split('\n').forEach((line, index) => {
    let from = 0;
    for (;;) {
      const at = line.indexOf('actions/runs/', from);
      if (at < 0) break;
      found.push({ file, line: index + 1, column: at + 1, text: line, index: at });
      from = at + 'actions/runs/'.length;
    }
  });
  return found;
}

// A span is `module` inside the shared module, `url` for a browsable GitHub URL,
// `sub-resource` for a `/jobs`, `/artifacts`, `/attempts` (etc.) read or a
// `?per_page=` query, `exempt` for an exact listed row, and `unclassified`
// otherwise. The module's own occurrences are judged by `moduleVerdict`.
function classifySpan(span, exemptions = EXEMPTIONS) {
  if (span.file === MODULE) return 'module';
  const before = span.text.slice(0, span.index);
  const after = span.text.slice(span.index + 'actions/runs/'.length);
  if (BROWSABLE_HOST.test(before) && REPOSITORY_SEGMENT.test(before)) return 'url';
  if (SUB_RESOURCES.test(after)) return 'sub-resource';
  if ((exemptions[span.file] ?? []).includes(span.line)) return 'exempt';
  return 'unclassified';
}

// A second `actions/runs/` occurrence inside the module already fails the span
// count; the template must also be the by-id path literal, not a URL or a
// hand-rolled variant.
function moduleVerdict(moduleText, moduleSpans) {
  if (moduleSpans.length !== 1) {
    return `it holds ${moduleSpans.length} actions/runs/ occurrences and must hold exactly one, the by-id path template`;
  }
  return moduleText.includes(MODULE_TEMPLATE) ? undefined : `its one occurrence is not the template ${MODULE_TEMPLATE}`;
}

const spanOf = (file, text, line = 7) => {
  const index = text.indexOf('actions/runs/');
  return { file, line, column: index + 1, text, index };
};

/** The `file:line:column` a problem is reported at, from the span it was found on. */
const where = span => `${span.file}:${span.line}:${span.column}`;

test('every workflow-script by-id read of an Actions run goes through the shared module', () => {
  const files = trackedScanFiles();
  // A scan set that silently emptied itself would make every assertion below pass
  // vacuously, so prove it still sees the module, the handoff and a workflow.
  assert.ok(files.includes(MODULE), `${MODULE} must be tracked: the census scans git ls-files`);
  assert.ok(files.includes(HANDOFF), `${HANDOFF} must be in the scan set`);
  assert.ok(files.includes('.github/workflows/release.yml'), 'the workflow YAML must be in the scan set');
  const spans = files.flatMap(file => occurrencesOf(file, stripComments(file, readText(file))));
  const moduleSpans = spans.filter(span => span.file === MODULE);
  const problems = [];
  const moduleProblem = moduleVerdict(readText(MODULE), moduleSpans);
  if (moduleProblem !== undefined) {
    problems.push(`${MODULE}: ${moduleProblem}; keep the one readCreatedRunById path there`);
  }
  for (const span of spans) {
    if (span.file === MODULE) continue;
    if (classifySpan(span) !== 'unclassified') continue;
    problems.push(`${where(span)}: a by-id read of an Actions run outside the shared module;`
      + ` call readCreatedRunById from ${MODULE}`);
  }
  // `gh run view`/`gh run watch` read a run's state without spelling the API path;
  // a workflow-run path without a query is a by-id read the same way.
  for (const file of files) {
    stripComments(file, readText(file)).split('\n').forEach((line, index) => {
      if (/\bgh\s+run\s+(?:view|watch)\b/.test(line)) {
        problems.push(`${file}:${index + 1}:1: ` + '`gh run view`/`gh run watch` reads a run outside the shared module;'
          + ` call readCreatedRunById from ${MODULE}`);
      }
      if (/actions\/workflows\/[^\s`'"$]+\/runs\/\d+/.test(line)) {
        problems.push(`${file}:${index + 1}:1: a workflow-run id read outside the shared module;`
          + ` call readCreatedRunById from ${MODULE}`);
      }
    });
  }
  assert.deepEqual(problems, [], 'every by-id read of an Actions run must go through the shared module');

  // The Client has no exemption: the row set is empty by design, and the handoff's
  // two spans are cleared by rules 2-3 rather than by an allowlist — so the census
  // is seeing the file that used to spell its by-id read instead of passing because
  // nothing is there.
  assert.deepEqual(Object.keys(EXEMPTIONS), [], 'the Client records no exemption row; a new read must be written against the module');
  const handoffSpans = spans.filter(span => span.file === HANDOFF);
  assert.ok(handoffSpans.some(span => classifySpan(span) === 'sub-resource'),
    `${HANDOFF} must still show its job-list read, cleared as a sub-resource`);
  assert.deepEqual(handoffSpans.filter(span => classifySpan(span) === 'unclassified'), [],
    `${HANDOFF} may not spell a by-id run read`);
});

test('the retry policy is defined once, in the module, and never redefined in the Client', () => {
  const files = trackedScanFiles();
  for (const name of ['RUN_READ_ATTEMPTS', 'RUN_READ_WAIT_MS', 'runReadWaits']) {
    const definitions = files.filter(file => new RegExp(
      `^export\\s+(?:async\\s+)?(?:const|let|var|function|class)\\s+${name}\\b`, 'm').test(readText(file)));
    assert.deepEqual(definitions, [MODULE], `${name} must be defined only in ${MODULE}`);
    // Not even a private copy: the Client carries no policy-symbol re-export and no
    // import of these three names.
    const mentions = files.filter(file => new RegExp(`\\b${name}\\b`).test(readText(file)));
    assert.deepEqual(mentions, [MODULE], `${name} must be mentioned only in ${MODULE}; this repository gets no re-export`);
  }
  // The doubling construction belongs to the module alone, so no caller can grow a
  // second schedule. The token `2 **` alone is not enough to flag: it also appears
  // in application code outside this scan set.
  const doubling = files.filter(file => readText(file).includes('baseMs * 2 ** index'));
  assert.deepEqual(doubling, [MODULE], 'the doubling schedule may only be written in the module');
});

test('the module bytes equal the pinned digest and the module has no dependencies', () => {
  const moduleText = readText(MODULE);
  const normalised = moduleText.replace(/\r\n/g, '\n');
  const digest = createHash('sha256').update(Buffer.from(normalised, 'utf8')).digest('hex');
  assert.equal(digest, PINNED_DIGEST,
    `the vendored module changed: observed ${digest}. Re-pin this constant in all three repositories and vendor`
    + ' the same bytes; the canonical path is AnyWear-Infra/scripts/lib/created-run-read.mjs');
  assert.equal(/\bimport\b/.test(moduleText), false, 'the module must import nothing');
  assert.equal(/process\.env/.test(moduleText), false, 'the module must read no environment');
  assert.equal(/readFile/.test(moduleText), false, 'the module must touch no filesystem');
});

test('the restricted requireSuccess flag appears only at the handoff read', () => {
  const hits = [];
  for (const file of trackedScanFiles()) {
    readText(file).split('\n').forEach((line, index) => {
      if (line.includes('requireSuccess: false')) hits.push({ file, line: index + 1 });
    });
  }
  assert.equal(hits.length, 1, 'exactly one read may accept a terminal non-success run');
  assert.equal(hits[0].file, HANDOFF, 'the handoff is the one caller whose claim is the deploy job, not the whole run');
  const handoff = readText(HANDOFF);
  const readStart = handoff.split('\n').findIndex(line => line.startsWith('export async function readRunById')) + 1;
  assert.ok(readStart > 0, 'readRunById must exist');
  assert.ok(hits[0].line > readStart, `requireSuccess: false must be inside readRunById, found at line ${hits[0].line}`);
  const readBody = handoff.slice(handoff.indexOf('export async function readRunById'));
  const nextExport = readBody.indexOf('\nexport ');
  const bounded = nextExport < 0 ? readBody : readBody.slice(0, nextExport);
  assert.ok(bounded.includes('requireSuccess: false'), 'readRunById calls the module with the flag');
});

// The classifier is self-tested so a broken pattern cannot make the census pass
// vacuously: one plain API path that fails, one browsable URL that passes, one
// Actions-expression URL that passes, one `api.github.com` path that fails, one
// sub-resource that passes, one exemption span that passes (with a synthetic row,
// because this repository has none), and a module holding two occurrences that
// fails.
test('the classifier itself distinguishes a module path, a URL, a sub-resource and an exemption', () => {
  assert.equal(classifySpan(spanOf('scripts/probe.mjs',
    'const probe = `gh api repos/anywear-ai/AnyWear-E2E/actions/runs/${runId}`;')), 'unclassified');
  assert.equal(classifySpan(spanOf('scripts/probe.mjs',
    'const url = `https://github.com/${repository}/actions/runs/${runId}`;')), 'url');
  // The workflow-expression spelling `release.yml:241` uses: an `api.github.com`
  // path is not browsable, but a URL built from `github.server_url` and
  // `github.repository` is.
  assert.equal(classifySpan(spanOf('.github/workflows/release.yml',
    '      CLIENT_RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}', 241)), 'url');
  assert.equal(classifySpan(spanOf('scripts/probe.mjs',
    'const url = `https://api.github.com/repos/anywear-ai/AnyWear-E2E/actions/runs/${runId}`;')), 'unclassified');
  assert.equal(classifySpan(spanOf('scripts/probe.mjs',
    'const jobs = `${base}/actions/runs/${runId}/jobs`;')), 'sub-resource');
  assert.equal(classifySpan(spanOf('.github/workflows/client-beta-apk.yml',
    '            "- built by ${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" > notes.md', 419)), 'url');
  assert.equal(classifySpan(spanOf('scripts/legacy-read.mjs',
    '  const run = await readApi(restPath(`actions/runs/${runId}`));', 12),
  { 'scripts/legacy-read.mjs': Object.freeze([12]) }), 'exempt');
  assert.equal(classifySpan(spanOf('scripts/legacy-read.mjs',
    '  const run = await readApi(restPath(`actions/runs/${runId}`));', 13),
  { 'scripts/legacy-read.mjs': Object.freeze([12]) }), 'unclassified',
  'an exemption is line-exact, so the same file one line over is not cleared');
  const moduleSpan = spanOf(MODULE, `const readPath = ${MODULE_TEMPLATE};`, 92);
  assert.equal(moduleVerdict(readText(MODULE), [moduleSpan]), undefined, 'one template occurrence passes');
  assert.notEqual(moduleVerdict(readText(MODULE), [moduleSpan, moduleSpan]), undefined,
    'a module holding two occurrences fails, so the implementation cannot grow a site of its own');
});
