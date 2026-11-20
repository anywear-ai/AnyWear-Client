// The Client's credential-free publication verification.
//
// The Client builds and verifies the Beta web bundle and hands it to
// `AnyWear-Infra`, which is the single writer of Beta's served tuple (ADR 0033 §9).
// The workflow therefore runs one phase only, `verify`:
//
//   * the workflow identity that still applies to `build`/`verify` — this repository,
//     `main`, `release.yml`, the exact source SHA, the run identity and the stage
//     switch;
//   * the built metadata against the declared interface — the dispatch overrides or
//     the reviewed workflow constants a push compiles — and the compiled assets
//     against the values the metadata records;
//   * the bundle manifest against `build-metadata.json`, against the asset inventory
//     it names, and against the `client_bundle_digest` the `build` job published, so
//     `verify` proves the digest's subject.
//
// The `deploy` and `record` phases are retired with the AWS path: the live-interface
// refusal, the S3 sync, the CloudFront invalidation and the publication record moved
// into `AnyWear-Infra`'s `publish-client` `deploy` job. Nothing here reads an AWS
// account, region or role, and no phase here assumes one.

import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildInterface, isValidInterfaceValue } from '../../scripts/build-interface.mjs';
import {
  bundleManifestComponent,
  bundleManifestName,
  bundleManifestSchemaVersion,
  inventoryBuiltAssets,
  sha256,
} from '../../scripts/write-bundle-manifest.mjs';

const runIdPattern = /^[1-9]\d*$/;
const digestPattern = /^[0-9a-f]{64}$/;

// The environment variable that carries each declared interface value: the manual
// dispatch overrides, or the reviewed workflow constants a push compiles.
const interfaceEnvironment = {
  api_base_url: 'API_BASE_URL',
  cognito_user_pool_id: 'COGNITO_USER_POOL_ID',
  cognito_client_id: 'COGNITO_CLIENT_ID',
};

/** The one phase this repository still runs. */
const verifyPhase = 'verify';

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function assertWorkflowIdentity(env) {
  requireCondition(env.BETA_MUTATION_ENABLED === 'true', 'Beta Client release is disabled');
  // The repository is keyed on its numeric id, which stays the same when the
  // repository moves to another owner, so the owner-qualified name is not part of
  // the guard: either owner may publish while the id and the ref are unchanged.
  requireCondition(env.GITHUB_REPOSITORY_ID === '1176104200'
    && env.GITHUB_REF === 'refs/heads/main', 'Publication requires the Client repository id 1176104200 and main ref');
  // The one publication entry has two events: a merge to `main` publishes, and a
  // manual dispatch keeps its `deploy` operation. Both are this workflow on `main`
  // in the run's own repository; no other event is a publication.
  requireCondition((env.GITHUB_EVENT_NAME === 'workflow_dispatch' || env.GITHUB_EVENT_NAME === 'push')
    && env.GITHUB_WORKFLOW_REF === `${env.GITHUB_REPOSITORY}/.github/workflows/release.yml@refs/heads/main`, 'Publication requires the main deploy workflow dispatch or a push to main');
  requireCondition(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
    && env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA, 'Publication requires the exact workflow source SHA');
  requireCondition(runIdPattern.test(env.GITHUB_RUN_ID ?? '')
    && runIdPattern.test(env.GITHUB_RUN_ATTEMPT ?? ''), 'Missing Actions run identity');
}

function assertBuiltMetadata(env, metadata) {
  requireCondition(metadata?.schema_version === 3
    && metadata.component === 'AnyWear-Client'
    && metadata.source_commit === env.GITHUB_SHA, 'Built Client metadata does not match the workflow source');
  requireCondition(Number.isSafeInteger(metadata.client_version) && metadata.client_version >= 0,
    'Built Client metadata has a malformed client_version');
  for (const key of Object.keys(buildInterface)) {
    requireCondition(isValidInterfaceValue(key, metadata.interface?.[key]), `Built Client metadata has a malformed ${key}`);
  }
  for (const [key, suffix] of Object.entries(interfaceEnvironment)) {
    requireCondition(env[`DECLARED_${suffix}`] === metadata.interface[key], `Built Client metadata does not match the declared interface values (${key})`);
  }
}

/**
 * The `verify` phase. `deploy` and `record` are refused rather than ignored: a
 * caller that still names them is running a workflow that has not retired the AWS
 * path, and silently accepting the phase would verify nothing.
 */
export function assertClientPublication(env, phase, input) {
  requireCondition(phase === verifyPhase, `Unknown publication validation phase: ${phase}`);
  assertWorkflowIdentity(env);
  assertBuiltMetadata(env, input);
}

/** Every interface value the metadata records must be present in the built assets. */
export function assertBuiltConfiguration(assetsDirectory, interfaceValues) {
  const assets = [];
  const pending = [assetsDirectory];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (/\.(?:[cm]?js|css|html|json|svg)$/.test(entry.name)) {
        assets.push(readFileSync(entryPath, 'utf8'));
      }
    }
  }
  const built = assets.join('\n');
  for (const [key, value] of Object.entries(interfaceValues)) {
    requireCondition(built.includes(value), `Built assets do not contain the ${key} recorded in build-metadata.json`);
  }
}

/**
 * The bundle manifest, proven three ways: it matches the build metadata, it is the
 * sorted inventory of every asset the downloaded build actually contains, and its
 * own SHA-256 is the digest `build` published and `handoff` hands to Infra. Returns
 * the recomputed digest.
 */
export async function assertBundleManifest(distDirectory, metadata, declaredDigest) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(distDirectory, bundleManifestName), 'utf8'));
  } catch (error) {
    throw new Error(`the bundle manifest cannot be read: ${error.message}`);
  }
  requireCondition(manifest?.schema_version === bundleManifestSchemaVersion
    && manifest.component === bundleManifestComponent, 'Bundle manifest has an unexpected schema or component');
  requireCondition(manifest.source_commit === metadata.source_commit,
    'Bundle manifest does not match build-metadata.json (source_commit)');
  requireCondition(manifest.client_version === metadata.client_version,
    'Bundle manifest does not match build-metadata.json (client_version)');
  for (const key of Object.keys(buildInterface)) {
    requireCondition(manifest.interface?.[key] === metadata.interface[key],
      `Bundle manifest does not match build-metadata.json (interface ${key})`);
  }

  const recorded = manifest.assets;
  requireCondition(Array.isArray(recorded) && recorded.length > 0, 'Bundle manifest records no built assets');
  const paths = recorded.map((asset) => asset?.path);
  requireCondition(paths.every((path) => typeof path === 'string' && path !== ''), 'Bundle manifest records an asset with no path');
  const sorted = [...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  requireCondition(paths.length === sorted.length && paths.every((path, index) => path === sorted[index]),
    'Bundle manifest inventory is not sorted by path');
  requireCondition(!paths.includes(bundleManifestName), 'Bundle manifest must not list itself');

  const expected = new Map((await inventoryBuiltAssets(distDirectory)).map((asset) => [asset.path, asset]));
  for (const path of expected.keys()) {
    requireCondition(paths.includes(path), `Built asset ${path} is missing from the bundle manifest`);
  }
  for (const asset of recorded) {
    const actual = expected.get(asset.path);
    requireCondition(actual !== undefined, `Bundle manifest lists ${asset.path}, which the build does not contain`);
    requireCondition(asset.sha256 === actual.sha256 && asset.bytes === actual.bytes,
      `Built asset ${asset.path} does not match the bundle manifest`);
  }

  const digest = sha256(readFileSync(join(distDirectory, bundleManifestName)));
  requireCondition(digestPattern.test(declaredDigest ?? ''), 'The build did not publish a client_bundle_digest');
  requireCondition(digest === declaredDigest,
    `The bundle manifest digest is ${digest}, not the published client_bundle_digest ${declaredDigest}`);
  return digest;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    const phase = process.argv[2];
    const distDirectory = fileURLToPath(new URL('../../dist/', import.meta.url));
    const input = JSON.parse(readFileSync(join(distDirectory, 'build-metadata.json'), 'utf8'));
    assertClientPublication(process.env, phase, input);
    assertBuiltConfiguration(join(distDirectory, 'assets'), input.interface);
    const digest = await assertBundleManifest(distDirectory, input, process.env.CLIENT_BUNDLE_DIGEST);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `### Client publication identity (${phase})\n\n`
        + `- Client source: \`${process.env.GITHUB_SHA}\`\n`
        + `- Run/attempt: \`${process.env.GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT}\`\n`
        + `- Bundle manifest: \`${bundleManifestName}\`, sha256 \`${digest}\`\n\n`);
    }
    console.log(`Validated the Beta Client bundle for handoff (${phase}), digest ${digest}`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
