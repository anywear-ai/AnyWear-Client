// Contract and validator for the Client CI credential boundary.
//
// Client CI holds two GitHub App installation tokens, each minted once, in one
// job, for exactly one repository and one permission:
//
//   build.yml:build      AnyWear-Service-API  contents: read   the OpenAPI spec
//   release.yml:handoff  AnyWear-E2E          actions: write  the smoke dispatch
//
// Everything else the workflows read is this public repository, or a public
// action. The constants below are the allowlist the workflows must request and
// the only jobs allowed to hold the resulting token. Each site's `with:` key set
// is closed, because an undeclared key on the pinned action can leave the full
// installation grant. `validateSourceCiCredentialBoundary` reports every way a
// workflow departs from them.
//
// The `with:` strings are the literal values a workflow must contain, so the
// strings asserted here are the ones the pinned action receives in CI.

import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The two — and only two — jobs that may mint a token, each with its own action
 * pin, repository allowlist and permission. The pins are immutable commits: the
 * credential-bearing step must not change under a workflow, and `build.yml` keeps
 * the v2 line its specification checkout and offline tests are written against.
 */
export const tokenSites = [
  {
    workflow: 'build.yml',
    job: 'build',
    ref: 'fee1f7d63c2ff003460e3d139729b119787bc349',
    version: 'v2.2.2',
    repository: 'AnyWear-Service-API',
    permissions: { contents: 'read' },
    // The only site that checks a private repository out, and the only one the
    // specification-checkout rules govern.
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
];

const specificationSite = tokenSites.find((site) => site.readsSpecification);

/**
 * #278: the nine signing secrets, each closed to the one platform job that reads
 * it. GitHub scopes a repository secret to the repository, not to a job, so this
 * table is the source-level boundary: a reference from another job (or from any
 * other workflow) fails `pnpm run test:run` instead of widening what a tag run can
 * read. The workflow that may carry them is named once, so the closed table cannot
 * be satisfied by a same-named job in a different workflow.
 */
export const signingSites = {
  'package-windows': ['WINDOWS_CERTIFICATE', 'WINDOWS_CERTIFICATE_PASSWORD'],
  'package-macos': ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_API_KEY_P8'],
  'package-android': ['ANDROID_KEY_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'],
};

/** The only workflow whose jobs may reference a signing secret. */
export const signingWorkflow = 'client-release.yml';

/**
 * #278: the write permissions a job-level `permissions:` block may grant, each
 * closed to the named job that holds it. `contents: read` is allowed on any job;
 * `release.yml:deploy` already holds `id-token: write` for its AWS boundary and is
 * named here rather than exempted implicitly.
 */
export const jobPermissionSites = {
  'client-release.yml:publish': ['contents: write'],
  'client-release.yml:assemble': ['id-token: write', 'attestations: write'],
  'release.yml:deploy': ['id-token: write'],
};

/** Every signing secret name, and the job each is closed to. */
export const signingSecretSites = new Map(
  Object.entries(signingSites).flatMap(([job, names]) => names.map((name) => [name, job])),
);

export const sourceCiCredentialBoundary = {
  // The App-token action. Each site pins its own line of it by commit.
  tokenAction: {
    repository: 'actions/create-github-app-token',
    inputs: {
      'app-id': '${{ vars.APP_ID }}',
      'private-key': '${{ secrets.APP_PRIVATE_KEY }}',
      owner: '${{ github.repository_owner }}',
    },
  },
  tokenSites,
  // The owner the specification checkout must name, written as the expression the
  // workflow resolves at run time. The Client may live under either owner during
  // the move to `anywear-ai`; only the repository name is a literal, so the same
  // checkout works on both sides of the transfer.
  ownerExpression: '${{ github.repository_owner }}',
  // The one repository the source-CI token may check out, as the bare name the
  // pinned action resolves against `owner`, and where it is checked out.
  specificationRepository: specificationSite.repository,
  specificationPath: 'api',
  // The only secret a Client workflow may carry, and the caller job that maps it
  // into the called workflow that declares it.
  secret: 'APP_PRIVATE_KEY',
  secretCallerJob: 'build',
};

/** Every `key: value` one token site's `with:` block must contain, and no other. */
export function tokenSiteWith(site) {
  return {
    ...sourceCiCredentialBoundary.tokenAction.inputs,
    repositories: site.repository,
    ...Object.fromEntries(
      Object.entries(site.permissions).map(([name, level]) => [`permission-${name}`, level]),
    ),
  };
}

// The source-CI site's `with:` block, kept as a named export because that is the
// token the source workflows already carry.
export const sourceCiCredentialBoundaryWith = tokenSiteWith(specificationSite);

/**
 * The `owner/repo` the specification checkout names. The default is the
 * owner-relative expression a workflow must contain; passing an owner resolves the
 * same repository under that account, which is what `.gitmodules` names.
 */
export function specificationRepositorySlug(owner = sourceCiCredentialBoundary.ownerExpression) {
  return `${owner}/${sourceCiCredentialBoundary.specificationRepository}`;
}

/**
 * The commit the index records for a submodule. This is the pointer the checkout is
 * supposed to fetch, read from the repository rather than from a literal a change can
 * leave behind. Works in a working tree, in a linked worktree and in a fresh clone.
 */
export async function readSubmoduleRevision(root, path) {
  const gitDirectory = await resolveGitDirectory(root);
  const index = await readFile(new URL('index', gitDirectory));
  return parseIndexGitlink(index, path);
}

/** The git directory holding this checkout's index and refs, as a directory URL. */
async function resolveGitDirectory(root) {
  const rootPath = fileURLToPath(root);
  const entryPath = resolve(rootPath, '.git');
  const stats = await stat(entryPath);
  if (stats.isDirectory()) return pathToFileURL(`${entryPath}${sep}`);
  const gitDirectoryText = /^gitdir:\s*(.+)$/m.exec(await readFile(entryPath, 'utf8'))?.[1]?.trim();
  if (!gitDirectoryText) throw new SourceCiCredentialBoundaryError(`\`${entryPath}\` does not name a git directory`);
  // A `gitdir` inside a `.git` file is relative to the directory holding that file.
  return pathToFileURL(`${resolve(rootPath, gitDirectoryText)}${sep}`);
}

/**
 * The `path` gitlink in a version 2/3/4 git index, whose entries are
 * `<ctime 8><mtime 8><dev 4><ino 4><mode 4><uid 4><gid 4><size 4><object id 20><flags 2>`
 * followed by the path, padded to a multiple of eight bytes.
 */
export function parseIndexGitlink(index, path) {
  const signature = index.subarray(0, 4).toString('latin1');
  if (signature !== 'DIRC') throw new SourceCiCredentialBoundaryError('The git index does not start with DIRC');
  const version = index.readUInt32BE(4);
  if (version < 2 || version > 4) throw new SourceCiCredentialBoundaryError(`Unsupported git index version ${version}`);
  const entryCount = index.readUInt32BE(8);

  const wanted = Buffer.from(path, 'utf8');
  let cursor = 12;
  for (let entry = 0; entry < entryCount; entry += 1) {
    const mode = index.readUInt32BE(cursor + 24);
    const objectId = index.subarray(cursor + 40, cursor + 60).toString('hex');
    let entryPath;
    if (version === 4) {
      const removed = index[cursor + 62];
      const length = readVariableLength(index, cursor + 63);
      const start = cursor + 63 + length.bytes;
      entryPath = Buffer.concat([Buffer.from(wanted.subarray(0, wanted.length - removed)), index.subarray(start, start + length.value)]);
      cursor = start + length.value;
    } else {
      const end = index.indexOf(0, cursor + 62);
      entryPath = index.subarray(cursor + 62, end);
      cursor = end + 1 + ((8 - ((end + 1 - cursor) % 8)) % 8);
    }
    if (!entryPath.equals(wanted)) continue;
    if (mode !== 0o160000) {
      throw new SourceCiCredentialBoundaryError(`Index entry \`${path}\` is mode ${mode.toString(8)}, not a gitlink`);
    }
    return objectId;
  }
  throw new SourceCiCredentialBoundaryError(`The git index records no \`${path}\` entry`);
}

/** A git index variable-length integer: the value with its most significant bits. */
function readVariableLength(index, start) {
  let value = index[start] & 0x7f;
  let cursor = start + 1;
  while ((index[cursor - 1] & 0x80) !== 0) {
    value = ((value + 1) << 7) | (index[cursor] & 0x7f);
    cursor += 1;
  }
  return { value, bytes: cursor - start };
}

/** Submodule path → repository its .gitmodules URL names. */
export function parseGitmodules(text) {
  const repositories = new Map();
  let path;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const pathMatch = /^path\s*=\s*(.+)$/.exec(line);
    if (pathMatch) {
      path = pathMatch[1].trim();
      continue;
    }
    const urlMatch = /^url\s*=\s*(.+)$/.exec(line);
    if (urlMatch) {
      if (path === undefined) throw new SourceCiCredentialBoundaryError(`.gitmodules declares a url before its path: ${line}`);
      const url = urlMatch[1].trim().replace(/\.git$/, '');
      const ownerAndName = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+)$/.exec(url);
      if (!ownerAndName) throw new SourceCiCredentialBoundaryError(`.gitmodules url is not a GitHub repository: ${line}`);
      repositories.set(path, ownerAndName[1]);
      path = undefined;
    }
  }
  if (path !== undefined) throw new SourceCiCredentialBoundaryError(`.gitmodules declares path '${path}' without a url`);
  return repositories;
}

export class SourceCiCredentialBoundaryError extends Error {}

const tokenStepPattern = /^actions\/create-github-app-token@(.+)$/;
const appIdVariablePattern = /\$\{\{\s*vars\.([A-Za-z0-9_]+)\s*\}\}/g;
const secretReferencePattern = /\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g;
const fullCommitPattern = /^[0-9a-f]{40}$/;

// The cloud-credential action vendors, matched by the action's repository prefix
// rather than by exact name: `azure/trusted-signing-action` is exactly the cloud
// signing mechanism ADR-0036 §5 leaves open, and an exact-name list would miss it.
const cloudCredentialActionVendors = new Map([
  ['aws-actions/', 'AWS'],
  ['azure/', 'Azure'],
  ['google-github-actions/', 'Google Cloud'],
]);
const vaultCredentialAction = 'hashicorp/vault-action';
// The `with:` inputs through which any vendor's action receives a cloud credential.
const cloudCredentialInputs = new Set([
  'aws-access-key-id',
  'aws-secret-access-key',
  'role-to-assume',
  'credentials-json',
  'workload_identity_provider',
  'tenant-id',
  'subscription-id',
]);
// `vars.NAME`, `vars['NAME']`, `vars["NAME"]` and any other `vars[...]` index. The
// last alternative is a computed name, which this scan cannot resolve.
const variableReferencePattern = /\bvars(?:\.([A-Za-z0-9_]+)|\[\s*(?:'([A-Za-z0-9_]+)'|"([A-Za-z0-9_]+)"|([^\]'"\s][^\]]*?))\s*\])/g;
// `ROLE` or `ARN` as a whole underscore-delimited segment: `LEARNING_MODE` is not
// role-shaped, and a `\b` assertion never falls inside `_ROLE_`.
const roleVariablePattern = /(?:^|_)(?:ROLE|ARN)(?:_|$)/;
const arnValuePattern = /arn:aws[a-z-]*:/;
const arnTextPattern = /arn:aws[a-z-]*:[^\s"']+/;
// A cloud CLI in command position: the first word of a shell command or pipeline
// segment, after the wrappers that still run the word behind them.
const cloudCommands = new Set(['aws', 'gcloud', 'az', 'sam', 'cdk', 'terraform', 'pulumi', 'eksctl']);
const commandRunnerTokens = new Set([
  'sudo', 'env', 'exec', 'nohup', 'time', 'bash', 'sh', 'zsh', 'pwsh', 'powershell',
  'cmd', 'npx', 'pnpm', 'npm', 'yarn', 'bunx', 'corepack', 'x', 'run', 'dlx',
]);

function violation(file, line, message) {
  return `${file}:${line} ${message}`;
}

/** `key: value` for one line, without quotes or a trailing comment. */
function keyValue(text) {
  const match = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(text);
  if (!match) return undefined;
  let value = match[2] ?? '';
  const isQuoted = value.length > 1
    && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')));
  if (isQuoted) return { key: match[1], value: value.slice(1, -1) };
  const commentAt = value.search(/\s#/);
  if (commentAt >= 0) value = value.slice(0, commentAt);
  return { key: match[1], value: value.trim() };
}

function childLines(block) {
  return block.filter((line) => line.text !== '' && !line.text.startsWith('#'));
}

function lineIndent(line) {
  return line.match(/^ */)[0].length;
}

function isBlank(line) {
  return line.text === '';
}

function isCommentLine(line) {
  return line.text.startsWith('#');
}

/**
 * Entries of one mapping level, beginning at `start`. An entry is either a nested
 * block (`key:` on its own line, with the block in `block`) or a scalar member
 * (`key: value`, with the text in `value`).
 */
function entriesAt(lines, start, indent) {
  const entries = [];
  let cursor = start;
  while (cursor < lines.length) {
    if (isBlank(lines[cursor]) || isCommentLine(lines[cursor])) {
      cursor += 1;
      continue;
    }
    if (lines[cursor].indent < indent) break;
    if (lines[cursor].indent > indent) {
      cursor += 1;
      continue;
    }
    const header = /^([A-Za-z0-9_.-]+):$/.exec(lines[cursor].text);
    if (!header) {
      const scalar = keyValue(lines[cursor].text);
      if (!scalar) throw new SourceCiCredentialBoundaryError(`Unsupported workflow syntax on line ${lines[cursor].number}: ${lines[cursor].text}`);
      entries.push({ key: scalar.key, number: lines[cursor].number, value: scalar.value, block: null });
      cursor += 1;
      continue;
    }
    // An entry's block starts one level deeper and runs to the next line at or above
    // this entry's own level. Deeper lines inside it belong to it, so a sibling key of
    // a nested mapping is never absorbed into the entry before it, and an entry followed
    // by a deeper sibling (a job before its first step) keeps that sibling.
    let content = cursor + 1;
    while (content < lines.length && (isBlank(lines[content]) || isCommentLine(lines[content]))) content += 1;
    const hasBlock = content < lines.length && lines[content].indent === indent + 2;
    let end = cursor + 1;
    if (hasBlock) {
      end = content;
      while (end < lines.length && (isBlank(lines[end]) || isCommentLine(lines[end]) || lines[end].indent > indent)) end += 1;
    }
    entries.push({
      key: header[1],
      number: lines[cursor].number,
      value: undefined,
      block: hasBlock
        ? trimBlankEdges(lines.slice(cursor + 1, end)).filter((line) => !isCommentLine(line))
        : null,
    });
    cursor = hasBlock ? end : cursor + 1;
  }
  return entries;
}

/** Scalar `key: value` entries of an entries list, taking `name` from the `- ` line. */
function entryValues(entries) {
  const pairs = new Map();
  for (const entry of entries) {
    if (entry.value === undefined) continue;
    pairs.set(entry.key, entry.value);
  }
  return pairs;
}

/** Lines of the block belonging to the entry at `start` of `block`. */
function entryLines(block, start) {
  const indent = block[start].indent;
  let end = start + 1;
  while (end < block.length) {
    if (isBlank(block[end]) || isCommentLine(block[end])) {
      end += 1;
      continue;
    }
    if (block[end].indent <= indent) break;
    end += 1;
  }
  return trimBlankEdges(block.slice(start + 1, end)).filter((line) => !isCommentLine(line));
}

/** `- name: value` step entries of a `steps:` block, with their nested options. */
function stepEntries(lines, start) {
  const entries = [];
  let cursor = start;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (isBlank(line) || isCommentLine(line)) {
      cursor += 1;
      continue;
    }
    if (!line.text.startsWith('- ') && line.text !== '-') {
      throw new SourceCiCredentialBoundaryError(`Expected a workflow step on line ${line.number}: ${line.text}`);
    }
    let end = cursor + 1;
    while (end < lines.length && !(lines[end].text.startsWith('- ') || lines[end].text === '-')) end += 1;
    entries.push({
      first: { ...line, text: line.text.replace(/^-\s*/, '') },
      options: trimBlankEdges(lines.slice(cursor + 1, end)).filter((option) => !isCommentLine(option)),
      number: line.number,
    });
    cursor = end;
  }
  return entries;
}

function trimBlankEdges(lines) {
  const result = [...lines];
  while (result.length > 0 && isBlank(result[0])) result.shift();
  while (result.length > 0 && isBlank(result[result.length - 1])) result.pop();
  return result;
}

/** Scalar members of a step: `name` sits on the `- ` line, the rest one level in. */
function stepFields(step) {
  const fields = entryValues(entriesAt([step.first], 0, step.first.indent));
  for (const [key, value] of entryValues(entriesAt(step.options, 0, step.first.indent + 2))) fields.set(key, value);
  return fields;
}

/**
 * Reads the parts of a workflow file the credential boundary governs: the
 * workflow-level `permissions` block and `env:` values, each job's `environment:`
 * declaration and `env:` values, each step's `uses`/`with`/`env`/`run:` body, the
 * secrets a caller job maps into the workflow it calls, and the secrets a
 * `workflow_call` workflow declares. A job that declares neither `steps:` nor a
 * job-level `uses:` raises, because its steps cannot be read. Only the flow-style
 * subset this repository's workflows use is supported; anything else raises, so an
 * unreadable contract fails the check rather than passing silently.
 */
export function parseWorkflow(text, file) {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((raw, index) => ({ number: index + 1, indent: lineIndent(raw), text: raw.trim() }));

  const workflow = { file, permissions: null, env: null, envNumber: undefined, jobs: [], calls: [], callers: [] };
  const steps = [];
  const knownTopLevelKeys = ['name', 'on', 'run-name', 'permissions', 'concurrency', 'env', 'defaults', 'jobs'];
  const topLevel = entriesAt(lines, 0, 0);
  for (const entry of topLevel) {
    if (!knownTopLevelKeys.includes(entry.key)) {
      throw new SourceCiCredentialBoundaryError(`Unsupported top-level workflow key on line ${entry.number}: ${entry.key}`);
    }
  }

  for (const entry of topLevel) {
    if (entry.key === 'permissions') {
      workflow.permissions = { number: entry.number, grants: entryValues(entriesAt(entry.block ?? [], 0, 2)), inline: entry.value };
    }

    // The workflow-level `env:` values are inherited by every job and step, so the
    // packaging-entry scan must read them too, not just the per-job copy.
    if (entry.key === 'env') {
      workflow.env = entryValues(entriesAt(entry.block ?? [], 0, 2));
      workflow.envNumber = entry.number;
    }

    if (entry.key === 'on') {
      // `workflow_call` is a mapping; the other triggers are inline values.
      for (const call of entriesAt(entry.block ?? [], 0, 2).filter((trigger) => trigger.key === 'workflow_call')) {
        for (const secrets of entriesAt(call.block ?? [], 0, 4).filter((section) => section.key === 'secrets')) {
          for (const secret of entriesAt(secrets.block ?? [], 0, 6)) {
            const required = entriesAt(secret.block ?? [], 0, 8).find((option) => option.key === 'required');
            workflow.calls.push({ name: secret.key, required: required?.value, number: secret.number });
          }
        }
      }
    }

    if (entry.key !== 'jobs') continue;
    for (const job of entriesAt(entry.block ?? [], 0, 2)) {
      const jobEntries = entriesAt(job.block ?? [], 0, 4);
      // A job shape this reader cannot follow is a boundary it cannot verify: a
      // job-level `uses:` is a reusable-workflow call, and every other job must
      // declare `steps:` before its step scan can see it.
      const stepsEntry = jobEntries.find((jobEntry) => jobEntry.key === 'steps');
      const usesEntry = jobEntries.find((jobEntry) => jobEntry.key === 'uses');
      if (!stepsEntry && !usesEntry) {
        throw new SourceCiCredentialBoundaryError(`Unsupported workflow job on line ${job.number}: \`${job.key}\` declares neither \`steps:\` nor \`uses:\``);
      }
      const permissionsEntry = jobEntries.find((jobEntry) => jobEntry.key === 'permissions');
      const jobEnvEntry = jobEntries.find((jobEntry) => jobEntry.key === 'env');
      const environmentEntry = jobEntries.find((jobEntry) => jobEntry.key === 'environment');
      workflow.jobs.push({
        id: job.key,
        number: job.number,
        workflow: workflow.file,
        // The job-level permission grants and the `env:` values every step inherits,
        // so the boundary can confine a write permission and scan an inherited value.
        // The job-level `environment:` declaration is recorded separately, and each
        // step's `run:` body is recorded so a cloud CLI is scanned where it runs.
        // Adopting a cloud signing mechanism amends ADR-0036 §5 and the guard's
        // signing table in the same delivery; the refusal message says so too.
        permissions: permissionsEntry
          ? entryValues(entriesAt(permissionsEntry.block ?? [], 0, 6))
          : undefined,
        env: jobEnvEntry ? entryValues(entriesAt(jobEnvEntry.block ?? [], 0, 6)) : undefined,
        envNumber: jobEnvEntry?.number,
        environment: environmentEntry ? { number: environmentEntry.number, value: environmentEntry.value ?? '' } : undefined,
      });
      if (usesEntry) {
        const secrets = jobEntries.find((jobEntry) => jobEntry.key === 'secrets');
        const secretEntries = secrets ? entriesAt(secrets.block ?? [], 0, 6) : [];
        workflow.callers.push({
          job: job.key,
          number: usesEntry.number,
          uses: `uses: ${usesEntry.value ?? ''}`,
          secretsInherit: secrets?.value === 'inherit' || secretEntries.some((secret) => secret.value === 'inherit'),
          mappedSecrets: secretEntries
            .filter((secret) => secret.value !== undefined && secret.value !== 'inherit')
            .map((secret) => ({ key: secret.key, value: secret.value })),
        });
      }
      if (!stepsEntry || !stepsEntry.block) continue;
      const firstStep = childLines(stepsEntry.block)[0];
      if (!firstStep) continue;
      for (const step of stepEntries(stepsEntry.block, stepsEntry.block.indexOf(firstStep))) {
        const fields = stepFields(step);
        const withLine = step.options.find((line) => line.text === 'with:');
        const envLine = step.options.find((line) => line.text === 'env:');
        const runLine = step.options.find((line) => line.text === 'run:' || line.text.startsWith('run: '));
        let run;
        if (runLine) {
          const value = keyValue(runLine.text)?.value ?? '';
          if (/^[|>]/.test(value)) {
            // `run: |` and `run: >` are block scalars: entryLines gives the body lines.
            run = entryLines(step.options, step.options.indexOf(runLine))
              .map((line) => ({ number: line.number, text: line.text }));
          } else {
            // `run: cmd` is the inline scalar.
            run = [{ number: runLine.number, text: value }];
          }
        }
        steps.push({
          file: workflow.file,
          number: step.number,
          job: job.key,
          name: fields.get('name') ?? '',
          id: fields.get('id') ?? '',
          uses: fields.get('uses') ?? '',
          with: withLine ? entryValues(entriesAt(entryLines(step.options, step.options.indexOf(withLine)), 0, withLine.indent + 2)) : null,
          // Tauri reads its signing material through the environment, so the
          // secret scan covers `env:` as well as `with:`.
          env: envLine ? entryValues(entriesAt(entryLines(step.options, step.options.indexOf(envLine)), 0, envLine.indent + 2)) : null,
          // The `run:` body is recorded line by line, so a cloud CLI is scanned
          // where it is invoked rather than anywhere the word happens to appear.
          run,
        });
      }
    }
  }

  return { workflow, steps };
}

function secretReferences(value) {
  return [...value.matchAll(secretReferencePattern)].map((match) => match[1]);
}

function variableReferences(value) {
  return [...value.matchAll(appIdVariablePattern)].map((match) => match[1]);
}

/** The cloud vendor an action repository belongs to, or `undefined` for any other action. */
function cloudCredentialVendor(action) {
  for (const [prefix, vendor] of cloudCredentialActionVendors) {
    if (action.startsWith(prefix)) return vendor;
  }
  return action === vaultCredentialAction ? 'HashiCorp Vault' : undefined;
}

/** Every recorded value the packaging-entry scan reads, with the location it names. */
function packagingEntryValues(workflow, steps) {
  const values = [];
  for (const [name, value] of workflow.env ?? []) {
    values.push({ number: workflow.envNumber, location: `workflow env \`${name}\``, value });
  }
  for (const job of workflow.jobs) {
    for (const [name, value] of job.env ?? []) {
      values.push({ number: job.envNumber ?? job.number, location: `job \`${job.id}\` env \`${name}\``, value });
    }
  }
  for (const step of steps) {
    for (const [key, value] of step.with ?? []) {
      values.push({ number: step.number, location: `step \`${step.name}\` with \`${key}\``, value });
    }
    for (const [name, value] of step.env ?? []) {
      values.push({ number: step.number, location: `step \`${step.name}\` env \`${name}\``, value });
    }
    for (const line of step.run ?? []) {
      values.push({ number: line.number, location: `step \`${step.name}\` run`, value: line.text });
    }
  }
  return values;
}

/**
 * The index of the `)` that closes the `(` at `open`, or `-1` when it is
 * unclosed. Parentheses inside single or double quotes and escaped characters are
 * skipped, so a quoted parenthesis does not end the substitution early.
 */
function matchingParenthesis(text, open) {
  let depth = 0;
  let quote = null;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The cloud CLI one command segment starts with, or `undefined`. */
function cloudCommandInSegment(segment) {
  // `$(`, `(`, `&`, `!` and quotes may prefix a command, and may stack.
  const tokens = segment
    .replace(/^(?:\$\(|\(|&|!|['"`])+/, '')
    .trimStart()
    .split(/\s+/)
    .filter((token) => token !== '');
  while (tokens.length > 0 && commandRunnerTokens.has(tokens[0])) tokens.shift();
  if (tokens.length === 0) return undefined;
  const command = tokens[0]
    .replace(/^.*[\\/]/, '')
    .replace(/\.(?:exe|cmd|bat|ps1)$/i, '')
    .toLowerCase();
  return cloudCommands.has(command) ? command : undefined;
}

/**
 * The cloud CLI a shell body line invokes, or `undefined`.
 *
 * The line is scanned character by character, so a separator inside a quoted
 * string is literal and a command substitution is followed where it runs: `$(...)`
 * and backticks are scanned recursively in command position, including inside
 * double quotes (they execute there) and not inside single quotes (they do not).
 * A single `&` splits a command like `;` does, except in a redirection (`2>&1`,
 * `&>`). Only the first word of each segment is compared, so `aws-sdk`, a quoted
 * URL and prose stay silent.
 */
function cloudCommandOf(line) {
  let segment = '';
  let quote = null;

  /** Analyse the segment built so far and start a new one. */
  const flush = () => {
    const command = cloudCommandInSegment(segment);
    segment = '';
    return command;
  };

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (quote === "'") {
      if (character === "'") quote = null;
      segment += character;
      continue;
    }

    if (character === '\\') {
      // A backslash escapes the next character; single quotes were handled above.
      segment += line.slice(index, index + 2);
      index += 1;
      continue;
    }

    if (quote === '"') {
      if (character === '"') {
        quote = null;
        segment += character;
        continue;
      }
      if (character === '$' && line[index + 1] === '(') {
        const close = matchingParenthesis(line, index + 1);
        if (close >= 0) {
          const command = cloudCommandOf(line.slice(index + 2, close));
          if (command !== undefined) return command;
          index = close;
          continue;
        }
      }
      if (character === '`') {
        const close = line.indexOf('`', index + 1);
        if (close >= 0) {
          const command = cloudCommandOf(line.slice(index + 1, close));
          if (command !== undefined) return command;
          index = close;
          continue;
        }
      }
      segment += character;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      segment += character;
      continue;
    }

    if (character === '$' && line[index + 1] === '(') {
      const close = matchingParenthesis(line, index + 1);
      if (close >= 0) {
        const command = cloudCommandOf(line.slice(index + 2, close));
        if (command !== undefined) return command;
        // The substitution runs, but it is not a word of this segment.
        index = close;
        continue;
      }
    }

    if (character === '`') {
      const close = line.indexOf('`', index + 1);
      if (close >= 0) {
        const command = cloudCommandOf(line.slice(index + 1, close));
        if (command !== undefined) return command;
        index = close;
        continue;
      }
    }

    if (character === ';' || character === '|' || character === '&') {
      const doubled = line[index + 1] === character;
      // `2>&1`, `>&2`, `&>` and `&>>` redirect rather than start a command.
      const redirection = character === '&' && !doubled
        && (line[index - 1] === '>' || line[index + 1] === '>');
      if (!redirection) {
        const command = flush();
        if (command !== undefined) return command;
        if (doubled) index += 1;
        continue;
      }
    }

    segment += character;
  }

  return cloudCommandInSegment(segment);
}

/**
 * The packaging-entry boundary of one parsed workflow: `client-release.yml` holds
 * no GitHub Environment, no cloud principal and no cloud CLI.
 *
 * This is keyed to the one packaging entry by the caller. It is not a general rule
 * for the repository: `release.yml` is the web-publication entry and legitimately
 * assumes its own AWS role.
 */
function packagingEntryViolations(document) {
  const { workflow, steps } = document;
  const file = workflow.file;
  const violations = [];

  // (i) No job of the packaging entry declares a GitHub Environment.
  for (const job of workflow.jobs) {
    if (job.environment !== undefined) {
      const declared = job.environment.value === '' ? 'environment:' : `environment: ${job.environment.value}`;
      violations.push(violation(file, job.environment.number, `job \`${job.id}\` declares \`${declared}\`; the packaging entry holds no GitHub Environment, so no job may declare one — the Client workflow census is authoritative in pipeline_stages.md § Protected entry points`));
    }
  }

  // (ii) No cloud-credential action, no cloud-credential input, no job-level call.
  for (const step of steps) {
    const vendor = cloudCredentialVendor(step.uses.replace(/@.*$/, '').toLowerCase());
    if (vendor !== undefined) {
      violations.push(violation(file, step.number, `step \`${step.name}\` uses \`${step.uses}\`, a cloud-credential action (${vendor}); the packaging entry holds no cloud principal — adopting a cloud signing mechanism amends ADR-0036 §5 and the guard's signing table in the same delivery`));
      // A known cloud action is already one finding; the with-key rule below is for
      // the unknown vendor whose action name the guard cannot attribute.
      continue;
    }
    for (const key of step.with?.keys() ?? []) {
      if (!cloudCredentialInputs.has(key)) continue;
      violations.push(violation(file, step.number, `step \`${step.name}\` passes \`with: ${key}\`, a cloud-credential input; the packaging entry holds no cloud credential — adopting a cloud signing mechanism amends ADR-0036 §5 and the guard's signing table in the same delivery`));
    }
  }
  // A reusable-workflow call is refused even though its `uses:` is not a credential:
  // the called workflow's steps are outside every assertion the boundary can read.
  for (const caller of workflow.callers) {
    violations.push(violation(file, caller.number, `job \`${caller.job}\` calls \`${caller.uses.replace(/^uses:\s*/, '')}\`; the packaging entry inlines its steps so the boundary can read them`));
  }

  // (iii) No role-shaped variable reference and no AWS ARN value, scanned only in
  // values the workflow records — never in the file's prose.
  for (const { number, location, value } of packagingEntryValues(workflow, steps)) {
    for (const match of value.matchAll(variableReferencePattern)) {
      const name = match[1] ?? match[2] ?? match[3];
      if (name === undefined) {
        violations.push(violation(file, number, `${location} reads \`${match[0]}\`, whose name cannot be resolved; the packaging entry names no computed cloud reference`));
      } else if (roleVariablePattern.test(name)) {
        violations.push(violation(file, number, `${location} reads \`${match[0]}\`, a role-shaped variable; the packaging entry names no cloud role`));
      }
    }
    if (arnValuePattern.test(value)) {
      violations.push(violation(file, number, `${location} names \`${arnTextPattern.exec(value)?.[0] ?? 'an AWS ARN'}\`; the packaging entry names no cloud principal`));
    }
  }

  // (iv) No `run:` body invokes a cloud CLI.
  for (const step of steps) {
    for (const line of step.run ?? []) {
      const command = cloudCommandOf(line.text);
      if (command === undefined) continue;
      violations.push(violation(file, line.number, `step \`${step.name}\` runs \`${command}\` in its \`run:\` body; the packaging entry runs no cloud CLI`));
    }
  }

  return violations;
}

const boundarySecret = `\${{ secrets.${sourceCiCredentialBoundary.secret} }}`;

/**
 * Reports every way the parsed workflows depart from the credential boundary.
 *
 * `submoduleRepositories` maps a submodule path to the repository its .gitmodules
 * URL names, so a checkout that fetches a repository the allowlist does not name is
 * a violation; `specificationRevision` is the gitlink the specification checkout must
 * pin.
 */
export function validateSourceCiCredentialBoundary({ documents, submoduleRepositories = new Map(), specificationRevision }) {
  const violations = [];
  const steps = documents.flatMap((document) => document.steps);
  const workflowFiles = new Set(documents.map((document) => document.workflow.file));
  const siteOf = (file, job) => sourceCiCredentialBoundary.tokenSites.find((site) => site.workflow === file && site.job === job);
  const siteLabels = sourceCiCredentialBoundary.tokenSites.map((site) => `${site.workflow}:${site.job}`).join(', ');
  const credentialWorkflow = `${sourceCiCredentialBoundary.secretCallerJob}.yml`;
  const declaredSpecification = submoduleRepositories.get(sourceCiCredentialBoundary.specificationPath);
  const specificationOwner = declaredSpecification ? declaredSpecification.replace(/\/.*$/, '') : undefined;

  /** A signing secret's only permitted site: the named job of the named workflow. */
  const signingViolation = (file, job, secret, location) => {
    const siteJob = signingSecretSites.get(secret);
    if (siteJob === undefined) return undefined;
    if (file === signingWorkflow && job === siteJob) return undefined;
    return `${location} reads \`secrets.${secret}\`, which only \`${signingWorkflow}:${siteJob}\` may reference; signing is isolated per platform`;
  };

  /** A secret read outside both the App-token boundary and the signing table. */
  const outsideBoundary = (file, job, secret, location) => {
    if (signingSecretSites.has(secret)) return signingViolation(file, job, secret, location);
    return `${location} reads \`secrets.${secret}\`, which is outside the credential boundary`;
  };

  /** A job-level write permission, confined to the job that holds it. */
  const permissionViolation = (file, job, permission) => {
    if (permission === 'contents: read') return undefined;
    const sites = Object.entries(jobPermissionSites)
      .filter(([, permissions]) => permissions.includes(permission))
      .map(([site]) => site);
    if (sites.length === 0) {
      return `job \`${job}\` grants \`${permission}\`, which is not a reviewed job permission; only \`contents: write\` (\`client-release.yml:publish\`), \`id-token: write\` (\`client-release.yml:assemble\`, \`release.yml:deploy\`) and \`attestations: write\` (\`client-release.yml:assemble\`) are allowed`;
    }
    if (!sites.includes(`${file}:${job}`)) {
      return `job \`${job}\` grants \`${permission}\`, which only ${sites.map((site) => `\`${site}\``).join(' and ')} may hold`;
    }
    return undefined;
  };

  for (const { workflow } of documents) {
    if (!workflow.permissions) {
      violations.push(violation(workflow.file, 1, 'workflow must declare `permissions: contents: read`'));
    } else if (workflow.permissions.inline !== undefined) {
      violations.push(violation(workflow.file, workflow.permissions.number, `workflow must declare \`permissions: contents: read\` as a mapping, found \`${workflow.permissions.inline}\``));
    } else {
      const grants = [...workflow.permissions.grants.entries()];
      if (grants.length !== 1 || grants[0][0] !== 'contents' || grants[0][1] !== 'read') {
        violations.push(violation(workflow.file, workflow.permissions.number, `workflow permissions must be exactly \`contents: read\`, found ${JSON.stringify(Object.fromEntries(grants))}`));
      }
    }

    // A job-level permission grant is confined to the named job that holds it, and
    // a job-level `env:` value is scanned exactly like a step-level `env:` value:
    // every step in the job inherits it.
    for (const job of workflow.jobs) {
      for (const [name, value] of job.permissions ?? []) {
        const message = permissionViolation(workflow.file, job.id, `${name}: ${value}`);
        if (message !== undefined) violations.push(violation(workflow.file, job.number, message));
      }
      for (const [name, value] of job.env ?? []) {
        for (const secret of secretReferences(value)) {
          const message = outsideBoundary(workflow.file, job.id, secret, `job \`${job.id}\` env \`${name}\``);
          if (message !== undefined) violations.push(violation(workflow.file, job.number, message));
        }
      }
    }

    // A called workflow declares the one secret and nothing else, and only the
    // credential-bearing one declares anything at all.
    const declaresCredential = workflow.file === credentialWorkflow;
    if (declaresCredential && workflow.calls.length === 0) {
      violations.push(violation(workflow.file, 1, `\`${credentialWorkflow}\` must declare secret \`${sourceCiCredentialBoundary.secret}\``));
    }
    for (const call of workflow.calls) {
      if (!declaresCredential) {
        violations.push(violation(workflow.file, call.number, `\`${workflow.file}\` declares secret \`${call.name}\`, but it holds no credential; only \`${credentialWorkflow}\` does`));
      }
      if (call.name !== sourceCiCredentialBoundary.secret) {
        violations.push(violation(workflow.file, call.number, `called workflow must declare only \`${sourceCiCredentialBoundary.secret}\`, found \`${call.name}\``));
      }
      if (call.required !== 'true') {
        violations.push(violation(workflow.file, call.number, `called workflow must declare secret \`${call.name}\` as \`required: true\``));
      }
    }

    // Only the one caller job reaches that secret, through an exact mapping.
    for (const caller of workflow.callers) {
      const resolved = caller.uses.replace(/^uses:\s*\.\/\.github\/workflows\//, '');
      if (!workflowFiles.has(resolved)) {
        violations.push(violation(workflow.file, caller.number, `job \`${caller.job}\` calls \`${caller.uses}\`, which is not one of the workflow files under review`));
      }
      const carriesCredential = resolved === credentialWorkflow;
      if (carriesCredential !== (caller.job === sourceCiCredentialBoundary.secretCallerJob)) {
        violations.push(violation(workflow.file, caller.number, `the credential-bearing workflow is \`${credentialWorkflow}\`, and job \`${caller.job}\` resolves to \`${resolved}\``));
      }
      const passesSecret = caller.secretsInherit || caller.mappedSecrets.length > 0;
      if (passesSecret !== carriesCredential) {
        violations.push(violation(workflow.file, caller.number, `job \`${caller.job}\` ${passesSecret ? 'receives' : 'does not receive'} \`${sourceCiCredentialBoundary.secret}\`, but its called workflow ${carriesCredential ? 'declares it' : 'declares no secret'}`));
      }
      if (caller.secretsInherit) {
        violations.push(violation(workflow.file, caller.number, `job \`${caller.job}\` must map the required secret explicitly instead of \`secrets: inherit\``));
      }
      for (const secret of caller.mappedSecrets) {
        if (secret.key !== sourceCiCredentialBoundary.secret) {
          violations.push(violation(workflow.file, caller.number, `job \`${caller.job}\` passes \`${secret.key}\`, which is outside the credential boundary`));
        }
        if (secret.value !== boundarySecret) {
          violations.push(violation(workflow.file, caller.number, `job \`${caller.job}\` must pass \`${secret.key}: ${boundarySecret}\`, found \`${secret.key}: ${secret.value}\``));
        }
      }
    }
  }

  // The packaging entry is `client-release.yml` only. The confinement is the rule,
  // not a convenience: `release.yml` is the web-publication entry, declares its own
  // `environment:` and assumes its own AWS role, so a scan widened to every
  // workflow would report that correct tree as a violation.
  const signingDocument = documents.find((document) => document.workflow.file === signingWorkflow);
  if (signingDocument === undefined) {
    violations.push(violation(signingWorkflow, 1, '`client-release.yml` was not parsed; the packaging-entry boundary is unverified'));
  } else {
    violations.push(...packagingEntryViolations(signingDocument));
  }

  const tokenSteps = steps.filter((step) => tokenStepPattern.test(step.uses));
  if (tokenSteps.length === 0) {
    violations.push(violation('.github/workflows', 1, 'no App-token step was found; the boundary is unverified, so an emptied credential surface must be stated explicitly'));
  }
  const seenSites = new Set();

  for (const step of steps) {
    // Tauri reads `APPLE_*` and the Windows certificate through the environment,
    // so a step-level `env:` value is governed exactly like a `with:` value.
    for (const [name, value] of step.env ?? []) {
      for (const secret of secretReferences(value)) {
        const message = outsideBoundary(step.file, step.job, secret, `step \`${step.name}\` env \`${name}\``);
        if (message !== undefined) violations.push(violation(step.file, step.number, message));
      }
    }
    const tokenActionRef = tokenStepPattern.exec(step.uses);
    if (tokenActionRef) {
      // A token step is legal only in one of the two named jobs. Widening "any
      // workflow may mint a token" is exactly what this boundary prevents.
      const site = siteOf(step.file, step.job);
      if (!site) {
        violations.push(violation(step.file, step.number, `App-token step is in \`${step.file}:${step.job}\`, which is not one of the two token sites (${siteLabels})`));
        continue;
      }
      seenSites.add(`${site.workflow}:${site.job}`);
      const expectedTokenAction = `${sourceCiCredentialBoundary.tokenAction.repository}@${site.ref}`;
      if (step.uses !== expectedTokenAction) {
        violations.push(violation(step.file, step.number, `App-token step must be pinned to ${expectedTokenAction}, found ${step.uses}`));
      }
      if (!step.with) {
        violations.push(violation(step.file, step.number, 'App-token step must declare a `with:` block'));
        continue;
      }
      const expectedWith = tokenSiteWith(site);
      for (const [key, value] of Object.entries(expectedWith)) {
        const actual = step.with.get(key);
        if (actual !== value) {
          violations.push(violation(step.file, step.number, `App-token step must set \`${key}: ${value}\`, found ${actual === undefined ? 'nothing' : `\`${key}: ${actual}\``}`));
        }
      }
      for (const key of step.with.keys()) {
        if (!(key in expectedWith)) {
          violations.push(violation(step.file, step.number, `App-token step passes \`${key}\`, which is not one of the token site's boundary inputs (${Object.keys(expectedWith).join(', ')})`));
        }
      }
      const requested = (step.with.get('repositories') ?? '').split(/[\n,]+/).map((name) => name.trim()).filter((name) => name !== '');
      if (requested.length === 0) {
        violations.push(violation(step.file, step.number, 'App-token step must request an explicit repository allowlist; without `repositories` the token reaches every repository the installation grants'));
      }
      for (const name of requested) {
        if (name !== site.repository) {
          violations.push(violation(step.file, step.number, `App-token step requests \`${name}\`; the ${site.workflow} allowlist is exactly \`${site.repository}\``));
        }
      }
      const expectedPermissionKeys = Object.keys(site.permissions).map((name) => `permission-${name}`);
      const permissionKeys = [...step.with.keys()].filter((key) => key.startsWith('permission-'));
      if (permissionKeys.length !== expectedPermissionKeys.length || permissionKeys.some((key) => !expectedPermissionKeys.includes(key))) {
        violations.push(violation(step.file, step.number, `App-token step must request only ${expectedPermissionKeys.map((key) => `\`${key}\``).join(', ')}, found ${permissionKeys.length === 0 ? 'no permission input' : permissionKeys.join(', ')}`));
      }
      for (const key of permissionKeys) {
        const level = site.permissions[key.replace(/^permission-/, '')];
        if (level !== undefined && step.with.get(key) !== level) {
          violations.push(violation(step.file, step.number, `App-token step must request \`${key}: ${level}\`, found \`${key}: ${step.with.get(key)}\``));
        }
      }
      for (const name of secretReferences(step.with.get('app-id') ?? '')) {
        violations.push(violation(step.file, step.number, `App ID must not be read from a secret, found \`secrets.${name}\``));
      }
      for (const name of variableReferences(step.with.get('app-id') ?? '')) {
        if (name !== 'APP_ID') {
          violations.push(violation(step.file, step.number, `App ID must come from \`vars.APP_ID\`, found \`vars.${name}\``));
        }
      }
      continue;
    }

    // Every other checkout reads public content with the default credential.
    if (step.uses.startsWith('actions/checkout@')) {
      const repository = step.with?.get('repository') ?? '';
      if (repository === '') {
        if (step.with?.has('token')) {
          violations.push(violation(step.file, step.number, `the Client checkout must use the default credential; the App tokens belong to the two token sites (${siteLabels})`));
        }
        if (step.with?.get('path') !== undefined) {
          violations.push(violation(step.file, step.number, `the Client checkout must not set \`path\`; the specification is checked out at \`${sourceCiCredentialBoundary.specificationPath}\``));
        }
        if (specificationOwner !== undefined && step.with?.get('submodules') !== undefined && step.with.get('submodules') !== 'false') {
          violations.push(violation(step.file, step.number, `the Client checkout must not fetch submodules; the specification checkout reads \`${specificationOwner}/${sourceCiCredentialBoundary.specificationRepository}\` with the App token`));
        }
        continue;
      }
      // The checkout must name the owner-relative form, so the owner the repository
      // leaves behind, or the one it moves to, cannot be reintroduced as a literal.
      const expectedRepository = specificationRepositorySlug();
      if (repository !== expectedRepository) {
        violations.push(violation(step.file, step.number, `checkout fetches \`${repository}\`, which is not \`${expectedRepository}\``));
      }
      if (!siteOf(step.file, step.job)?.readsSpecification) {
        violations.push(violation(step.file, step.number, `a checkout of another repository belongs to ${specificationSite.workflow}:${specificationSite.job}, not to \`${step.file}:${step.job}\``));
      }
      if (step.with?.get('path') !== sourceCiCredentialBoundary.specificationPath) {
        violations.push(violation(step.file, step.number, `specification checkout must use \`path: ${sourceCiCredentialBoundary.specificationPath}\`, found \`path: ${step.with?.get('path') ?? 'nothing'}\``));
      }
      if (specificationRevision !== undefined) {
        const ref = step.with?.get('ref') ?? '';
        if (!fullCommitPattern.test(ref)) {
          violations.push(violation(step.file, step.number, `specification checkout must pin its revision by full commit, found \`ref: ${ref || 'nothing'}\``));
        } else if (ref !== specificationRevision) {
          violations.push(violation(step.file, step.number, `specification checkout pins \`${ref}\`, but the \`${sourceCiCredentialBoundary.specificationPath}\` submodule is checked out at \`${specificationRevision}\``));
        }
      }
      const token = step.with?.get('token') ?? '';
      if (!/^\$\{\{\s*steps\.[A-Za-z0-9_-]+\.outputs\.token\s*\}\}$/.test(token)) {
        violations.push(violation(step.file, step.number, `specification checkout must use a generated App token output, found \`${token || 'nothing'}\``));
      } else if (!tokenSteps.some((candidate) => candidate.id !== '' && token.includes(`steps.${candidate.id}.outputs.token`))) {
        violations.push(violation(step.file, step.number, `specification checkout reads \`${token}\`, but no App-token step declares that id`));
      }
      if (step.with?.get('persist-credentials') !== 'false') {
        violations.push(violation(step.file, step.number, `specification checkout must set \`persist-credentials: false\`, found \`${step.with?.get('persist-credentials') ?? 'nothing'}\``));
      }
      // The specification repository has no nested submodules of its own, and a
      // recursive fetch would ask the token for more than the allowlist names.
      const specificationSubmodules = step.with?.get('submodules');
      if (specificationSubmodules !== undefined && specificationSubmodules !== 'false') {
        violations.push(violation(step.file, step.number, `specification checkout must not fetch submodules; found \`submodules: ${specificationSubmodules}\``));
      }
      for (const value of step.with?.values() ?? []) {
        for (const name of secretReferences(value)) {
          violations.push(violation(step.file, step.number, `specification checkout reads \`secrets.${name}\` directly; it must use the generated App token output`));
        }
      }
      continue;
    }

    if (step.uses.startsWith('actions/checkout@') && step.with?.has('submodules') && step.with.get('submodules') !== 'false') {
      violations.push(violation(step.file, step.number, `only the specification checkout fetches repository content, and it uses \`path\`/\`repository\`; found \`submodules: ${step.with.get('submodules')}\``));
    }
    for (const value of step.with?.values() ?? []) {
      for (const name of secretReferences(value)) {
        if (name === sourceCiCredentialBoundary.secret) {
          violations.push(violation(step.file, step.number, `step reads \`secrets.${name}\`; only the two token sites (${siteLabels}) and the specification checkout carry that credential`));
        } else {
          violations.push(violation(step.file, step.number, `step reads \`secrets.${name}\`, which is outside the credential boundary`));
        }
      }
    }
  }

  // Both token sites must be present. A site that disappears fails here rather than
  // silently reducing the credential surface to one entry.
  for (const site of sourceCiCredentialBoundary.tokenSites) {
    if (!seenSites.has(`${site.workflow}:${site.job}`)) {
      violations.push(violation(site.workflow, 1, `no App-token step was found in \`${site.workflow}:${site.job}\`; the ${site.workflow} token site is unverified`));
    }
  }

  // The allowlist must name exactly what the specification checkout fetches.
  if (declaredSpecification === undefined) {
    violations.push(violation('.gitmodules', 1, `\`.gitmodules\` declares no \`${sourceCiCredentialBoundary.specificationPath}\` submodule; the allowlist would name a repository this checkout does not read`));
  } else if (declaredSpecification !== specificationRepositorySlug(specificationOwner)) {
    violations.push(violation('.gitmodules', 1, `\`${sourceCiCredentialBoundary.specificationPath}\` points at \`${declaredSpecification}\`, and the allowlist names \`${sourceCiCredentialBoundary.specificationRepository}\``));
  }
  for (const [path, repository] of submoduleRepositories) {
    if (path === sourceCiCredentialBoundary.specificationPath) continue;
    violations.push(violation('.gitmodules', 1, `submodule \`${path}\` points at \`${repository}\`, which no checkout in the boundary fetches`));
  }

  return violations;
}
