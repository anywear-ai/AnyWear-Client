import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildInterface, isValidInterfaceValue } from '../../scripts/build-interface.mjs';

const runIdPattern = /^[1-9]\d*$/;
const distributionIdPattern = /^[A-Z0-9]+$/;
const invalidationIdPattern = /^[A-Za-z0-9]+$/;

// The environment variable that carries each recorded interface value. `verify`
// compares the artifact against the reviewed dispatch inputs; `deploy` compares
// it against the live Beta interface resolved from CloudFormation and SSM.
const interfaceEnvironment = {
  api_base_url: 'API_BASE_URL',
  cognito_user_pool_id: 'COGNITO_USER_POOL_ID',
  cognito_client_id: 'COGNITO_CLIENT_ID',
};
const interfacePhase = {
  verify: { prefix: 'DECLARED', label: 'declared' },
  deploy: { prefix: 'LIVE', label: 'live Beta' },
};

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function assertWorkflowIdentity(env) {
  requireCondition(env.BETA_MUTATION_ENABLED === 'true', 'Beta Client release is disabled');
  requireCondition(env.GITHUB_REPOSITORY === 'git-malu/AnyWear-Client'
    && env.GITHUB_REPOSITORY_ID === '1176104200'
    && env.GITHUB_REF === 'refs/heads/main', 'Publication requires the original Client repository and main ref');
  requireCondition(env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && env.GITHUB_WORKFLOW_REF === 'git-malu/AnyWear-Client/.github/workflows/release.yml@refs/heads/main', 'Publication requires the main deploy workflow dispatch');
  requireCondition(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
    && env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA, 'Publication requires the exact workflow source SHA');
  requireCondition(env.AWS_ACCOUNT_ID === '650880818323' && env.AWS_REGION === 'ap-east-1', 'Unexpected Beta account or region');
  requireCondition(env.CLIENT_PUBLISH_ROLE_ARN === 'arn:aws:iam::650880818323:role/beta-client-publish-role', 'A dedicated Beta Client publish role is required');
  requireCondition(runIdPattern.test(env.GITHUB_RUN_ID ?? '')
    && runIdPattern.test(env.GITHUB_RUN_ATTEMPT ?? ''), 'Missing Actions run identity');
}

function assertBuiltMetadata(env, metadata, phase) {
  requireCondition(metadata?.schema_version === 3
    && metadata.component === 'AnyWear-Client'
    && metadata.source_commit === env.GITHUB_SHA, 'Built Client metadata does not match the workflow source');
  requireCondition(Number.isSafeInteger(metadata.client_version) && metadata.client_version >= 0,
    'Built Client metadata has a malformed client_version');
  for (const key of Object.keys(buildInterface)) {
    requireCondition(isValidInterfaceValue(key, metadata.interface?.[key]), `Built Client metadata has a malformed ${key}`);
  }
  const { prefix, label } = interfacePhase[phase];
  for (const [key, suffix] of Object.entries(interfaceEnvironment)) {
    requireCondition(env[`${prefix}_${suffix}`] === metadata.interface[key], `Built Client metadata does not match the ${label} interface values (${key})`);
  }
}

function assertPublicationRecord(env, record) {
  requireCondition(record?.schema_version === 1 && record.component === 'AnyWear-Client', 'Publication record has an unexpected schema or component');
  requireCondition(record.source_commit === env.GITHUB_SHA, 'Publication record does not match the workflow source');
  requireCondition(record.run_id === env.GITHUB_RUN_ID && record.run_attempt === env.GITHUB_RUN_ATTEMPT, 'Publication record does not match the Actions run identity');
  requireCondition(typeof record.bucket === 'string' && record.bucket !== '', 'Publication record has no bucket');
  requireCondition(distributionIdPattern.test(record.distribution_id ?? ''), 'Publication record has no CloudFront distribution id');
  requireCondition(invalidationIdPattern.test(record.invalidation_id ?? ''), 'Publication record has no invalidation id');
  for (const key of Object.keys(buildInterface)) {
    requireCondition(isValidInterfaceValue(key, record.interface?.[key]), `Publication record has a malformed ${key}`);
  }
}

export function assertClientPublication(env, phase, input) {
  requireCondition(phase === 'verify' || phase === 'deploy' || phase === 'record', 'Unknown publication validation phase');
  assertWorkflowIdentity(env);
  if (phase === 'record') {
    assertPublicationRecord(env, input);
  } else {
    assertBuiltMetadata(env, input, phase);
  }
}

/** Every interface value the metadata records must be present in the built assets. */
export function assertBuiltConfiguration(assetsDirectory, interfaceValues) {
  const assets = [];
  const pending = [assetsDirectory];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (/\.(?:[cm]?js|css|html|json|svg)$/.test(entry.name)) {
        assets.push(readFileSync(path, 'utf8'));
      }
    }
  }
  const built = assets.join('\n');
  for (const [key, value] of Object.entries(interfaceValues)) {
    requireCondition(built.includes(value), `Built assets do not contain the ${key} recorded in build-metadata.json`);
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    const phase = process.argv[2];
    const input = phase === 'record'
      ? JSON.parse(readFileSync(new URL('../../publication/publication-record.json', import.meta.url), 'utf8'))
      : JSON.parse(readFileSync(new URL('../../dist/build-metadata.json', import.meta.url), 'utf8'));
    assertClientPublication(process.env, phase, input);
    if (phase === 'verify') {
      assertBuiltConfiguration(fileURLToPath(new URL('../../dist/assets/', import.meta.url)), input.interface);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `### Client publication identity (${phase})\n\n`
        + `- Client source: \`${process.env.GITHUB_SHA}\`\n`
        + `- Run/attempt: \`${process.env.GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT}\`\n\n`);
    }
    console.log(`Validated Beta Client publication identity (${phase})`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
