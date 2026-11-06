// Tauri security and identity guard for the hardened desktop configuration.
//
// One test per guarded surface, all asserting parsed identity fields rather than
// bare substrings. The `@tauri-apps/*` dependency scopes belong to the vendor, so
// no assertion may treat `tauri-app` as a marker of this application.
//
// Guarded surfaces:
// - product identity: `package.json`, `Cargo.toml`, `tauri.conf.json`, `index.html`
// - `app.security.csp`: default-deny production policy, no network scheme-only
//   source, no `'unsafe-eval'`, no host wildcard outside the two reviewed
//   AWS/CloudFront entries, `script-src`/`style-src` exactly `'self'`
// - `app.security.devCsp`: distinct development policy that admits the Vite server,
//   its HMR socket and the local API fallback
// - capabilities: exactly the five reviewed permissions; every `fs` allow scope
//   stays inside `$APPDATA/cache`; no global `fs:scope` and no `opener:*`
// - asset protocol: exactly `$APPDATA/cache/images/**`
// - the removed scaffold `greet` command and opener plugin stay removed
// - the packaged-smoke configuration adds exactly the loopback fixture origin to
//   the production policy, so the smoke delta cannot drift
//
// Run with `pnpm run test:run`, which includes this file in its `node --test` list.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

export const CACHE_ROOT = '$APPDATA/cache';
export const CACHE_DIRECTORY = '$APPDATA/cache/images';
export const CACHE_DESCENDANTS = `${CACHE_DIRECTORY}/**`;
export const LOOPBACK_SMOKE_ORIGIN = 'http://127.0.0.1:*';

// The two reviewed host wildcards: pre-signed S3 image transfers and the
// CloudFront API/image ingress. No other wildcard source may appear in the policy.
export const REVIEWED_HOST_WILDCARDS = [
  'https://*.cloudfront.net',
  'https://*.s3.ap-east-1.amazonaws.com',
];

export const REVIEWED_PLAIN_PERMISSIONS = ['core:default', 'log:default'];
export const REVIEWED_COMMAND_PERMISSIONS = ['fs:allow-exists', 'fs:allow-mkdir', 'fs:allow-write-file'];
export const REVIEWED_PERMISSIONS = [...REVIEWED_PLAIN_PERMISSIONS, ...REVIEWED_COMMAND_PERMISSIONS];

export const PACKAGE_FILE = 'package.json';
export const CARGO_FILE = 'src-tauri/Cargo.toml';
export const CONFIG_FILE = 'src-tauri/tauri.conf.json';
export const CAPABILITY_FILE = 'src-tauri/capabilities/default.json';
export const HTML_FILE = 'index.html';
export const SMOKE_CONFIG_FILE = 'src-tauri/tauri.smoke.conf.json';
export const RUST_SOURCE_DIRECTORY = 'src-tauri/src';

export const EXPECTED_IDENTITY = {
  packageName: 'anywear-client',
  crateName: 'anywear',
  crateDescription: 'AnyWear desktop and mobile client',
  crateAuthors: ['AnyWear'],
  libraryName: 'anywear_lib',
  productName: 'AnyWear',
  windowTitle: 'AnyWear',
  htmlTitle: 'AnyWear',
  identifier: 'com.anywear.app',
  publisher: 'AnyWear',
  copyright: 'Copyright © 2026 AnyWear',
  category: 'Lifestyle',
  shortDescription: 'AnyWear — your wardrobe, styled.',
  longDescription:
    'AnyWear is a virtual try-on and wardrobe client. Capture your clothes, generate looks, and see them on your digital mannequin.',
};

// The reviewed production policy, character-for-character as the issue records it.
// Tauri appends its own nonces and hashes to `script-src`/`style-src` at compile
// time; this guard checks the source the repository owns.
export const PRODUCTION_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' asset: http://asset.localhost data: https://*.cloudfront.net https://*.s3.ap-east-1.amazonaws.com; connect-src 'self' ipc: http://ipc.localhost https://*.cloudfront.net https://*.s3.ap-east-1.amazonaws.com https://cognito-idp.ap-east-1.amazonaws.com; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";

// The reviewed development policy: the production sources plus the Vite server,
// its HMR socket and the local API fallback. `'unsafe-inline'` is dev-only.
export const DEVELOPMENT_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' asset: http://asset.localhost data: http://localhost:1420 http://localhost:3000 https://*.cloudfront.net https://*.s3.ap-east-1.amazonaws.com; connect-src 'self' ipc: http://ipc.localhost http://localhost:1420 ws://localhost:1420 ws://localhost:1421 http://localhost:3000 https://*.cloudfront.net https://*.s3.ap-east-1.amazonaws.com https://cognito-idp.ap-east-1.amazonaws.com; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'";

// The reviewed smoke policy: the production policy plus the loopback fixture
// origin on `connect-src` and `img-src` and nothing else.
export const SMOKE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' asset: http://asset.localhost data: https://*.cloudfront.net https://*.s3.ap-east-1.amazonaws.com http://127.0.0.1:*; connect-src 'self' ipc: http://ipc.localhost https://*.cloudfront.net https://*.s3.ap-east-1.amazonaws.com https://cognito-idp.ap-east-1.amazonaws.com http://127.0.0.1:*; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

export function readText(relativePath) {
  try {
    return readFileSync(join(repositoryRoot, relativePath), 'utf8');
  } catch (error) {
    throw new Error(`${relativePath} cannot be read: ${error.message}`);
  }
}

export function readJson(relativePath) {
  const text = readText(relativePath);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${relativePath} is not valid JSON: ${error.message}`);
  }
}

/** Every `.rs` file under `src-tauri/src`, so a re-added scaffold command is seen. */
export function readRustSources(directory = join(repositoryRoot, RUST_SOURCE_DIRECTORY)) {
  const sources = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      sources.push(...readRustSources(path));
      continue;
    }
    if (name.endsWith('.rs')) {
      sources.push({ file: path.slice(repositoryRoot.length).replaceAll('\\', '/'), text: readFileSync(path, 'utf8') });
    }
  }
  return sources;
}

/**
 * The identity fields this guard owns, extracted from `Cargo.toml` instead of the
 * raw text. Only the `[package]` and `[lib]` sections are read; string and array
 * values are parsed so a formatting change cannot pass as an identity change.
 */
export function parseCargoManifest(text, file = CARGO_FILE) {
  const sections = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      current = header[1];
      sections.set(current, new Map());
      continue;
    }
    if (current === null) continue;
    const assignment = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!assignment) continue;
    sections.get(current).set(assignment[1], assignment[2]);
  }

  const readString = (section, key) => {
    const raw = sections.get(section)?.get(key);
    if (raw === undefined) return undefined;
    const quoted = /^"(.*)"$/.exec(raw);
    return quoted ? quoted[1] : raw;
  };

  let authors;
  const rawAuthors = sections.get('package')?.get('authors');
  if (rawAuthors !== undefined) {
    try {
      authors = JSON.parse(rawAuthors);
    } catch (error) {
      throw new Error(`${file} has an unparsable authors array: ${error.message}`);
    }
  }

  return {
    package: {
      name: readString('package', 'name'),
      description: readString('package', 'description'),
      authors,
    },
    lib: { name: readString('lib', 'name') },
  };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value) {
  return typeof value === 'string' ? `\`${value}\`` : JSON.stringify(value);
}

/** Product identity fields, asserted by parsed value rather than file text. */
export function identityViolations({ packageJson, cargo, config, html }) {
  const violations = [];
  const expected = EXPECTED_IDENTITY;

  if (packageJson?.name !== expected.packageName) {
    violations.push(`${PACKAGE_FILE}: "name" must be \`${expected.packageName}\`, found ${describe(packageJson?.name)}`);
  }
  if (cargo?.package?.name !== expected.crateName) {
    violations.push(`${CARGO_FILE}: [package] name must be \`${expected.crateName}\`, found ${describe(cargo?.package?.name)}`);
  }
  if (cargo?.package?.description !== expected.crateDescription) {
    violations.push(
      `${CARGO_FILE}: [package] description must be \`${expected.crateDescription}\`, found ${describe(cargo?.package?.description)}; it must not keep scaffold text`,
    );
  }
  if (JSON.stringify(cargo?.package?.authors) !== JSON.stringify(expected.crateAuthors)) {
    violations.push(
      `${CARGO_FILE}: [package] authors must be ${JSON.stringify(expected.crateAuthors)}, found ${JSON.stringify(cargo?.package?.authors)}`,
    );
  }
  if (cargo?.lib?.name !== expected.libraryName) {
    violations.push(`${CARGO_FILE}: [lib] name must be \`${expected.libraryName}\`, found ${describe(cargo?.lib?.name)}`);
  }

  const htmlTitle = /<title>\s*([\s\S]*?)\s*<\/title>/i.exec(html ?? '')?.[1];
  if (htmlTitle !== expected.htmlTitle) {
    violations.push(`${HTML_FILE}: <title> must be \`${expected.htmlTitle}\`, found ${describe(htmlTitle)}`);
  }

  if (config?.productName !== expected.productName) {
    violations.push(`${CONFIG_FILE}: productName must be \`${expected.productName}\`, found ${describe(config?.productName)}`);
  }
  const windowTitle = config?.app?.windows?.[0]?.title;
  if (windowTitle !== expected.windowTitle) {
    violations.push(`${CONFIG_FILE}: app.windows[0].title must be \`${expected.windowTitle}\`, found ${describe(windowTitle)}`);
  }
  if (config?.identifier !== expected.identifier) {
    violations.push(
      `${CONFIG_FILE}: identifier must stay \`${expected.identifier}\` because the app-data directory and the cache path derive from it, found ${describe(config?.identifier)}`,
    );
  }
  for (const key of ['publisher', 'copyright', 'category', 'shortDescription', 'longDescription']) {
    if (config?.bundle?.[key] !== expected[key]) {
      violations.push(`${CONFIG_FILE}: bundle.${key} must be \`${expected[key]}\`, found ${describe(config?.bundle?.[key])}`);
    }
  }

  return violations;
}

/** Parses a CSP string into directive name → ordered source list. */
export function parseCspDirectives(csp) {
  const directives = new Map();
  for (const part of csp.split(';')) {
    const piece = part.trim();
    if (!piece) continue;
    const [name, ...sources] = piece.split(/\s+/);
    directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

const NETWORK_SCHEME_SOURCES = new Set(['http:', 'https:', 'ws:', 'wss:']);

/**
 * The policy bounds the issue records: non-empty, no network scheme-only source,
 * no `'unsafe-eval'`, no host wildcard outside the two reviewed entries, and
 * `script-src`/`style-src` exactly `'self'` before Tauri's build-time hashes.
 */
export function cspViolations(csp, label = CONFIG_FILE) {
  if (typeof csp !== 'string' || csp.trim() === '') {
    return [`${label}: app.security.csp must be a non-empty string, found ${describe(csp)}`];
  }

  const violations = [];
  const directives = parseCspDirectives(csp);
  for (const [directive, sources] of directives) {
    for (const source of sources) {
      const lower = source.toLowerCase();
      if (NETWORK_SCHEME_SOURCES.has(lower)) {
        violations.push(
          `${label}: ${directive} admits the network scheme-only source \`${source}\`, which permits every host on that scheme; name the origins explicitly`,
        );
      }
      if (lower === "'unsafe-eval'") {
        violations.push(`${label}: ${directive} admits \`'unsafe-eval'\`; the reviewed policy never needs it`);
      }
      if (source.includes('*') && !REVIEWED_HOST_WILDCARDS.includes(source)) {
        violations.push(
          `${label}: ${directive} admits the host wildcard \`${source}\`, which is outside the two reviewed entries (\`${REVIEWED_HOST_WILDCARDS.join('`, `')}\`)`,
        );
      }
    }
  }

  for (const directive of ['script-src', 'style-src']) {
    const sources = directives.get(directive);
    if (sources === undefined) {
      violations.push(`${label}: the policy must declare \`${directive}\``);
    } else if (sources.length !== 1 || sources[0] !== "'self'") {
      violations.push(
        `${label}: ${directive} must be exactly \`'self'\` before Tauri's build-time hashes, found ${sources.length === 0 ? 'no source' : `\`${sources.join(' ')}\``}`,
      );
    }
  }

  return violations;
}

/** The development policy is separate, admits the Vite/local origins, and stays a policy. */
export function devCspViolations(devCsp, productionCsp) {
  if (typeof devCsp !== 'string' || devCsp.trim() === '') {
    return [`${CONFIG_FILE}: app.security.devCsp must be a non-empty string; the development policy is recorded separately from the production one`];
  }
  if (devCsp === productionCsp) {
    return [`${CONFIG_FILE}: app.security.devCsp must differ from app.security.csp; a single policy cannot serve both the Vite server and the packaged app`];
  }

  const violations = [];
  for (const source of ['http://localhost:1420', 'ws://localhost:1421', 'http://localhost:3000']) {
    if (!devCsp.includes(source)) {
      violations.push(`${CONFIG_FILE}: app.security.devCsp must admit \`${source}\`; the dev run uses the Vite server, its HMR socket and the local API fallback`);
    }
  }
  if (devCsp.toLowerCase().includes("'unsafe-eval'")) {
    violations.push(`${CONFIG_FILE}: app.security.devCsp must not admit \`'unsafe-eval'\``);
  }

  return violations;
}

/** The capability carries exactly the five reviewed permissions, each fs scope inside the cache. */
export function capabilityViolations(capability) {
  const permissions = capability?.permissions;
  if (!Array.isArray(permissions)) {
    return [`${CAPABILITY_FILE}: the capability must declare a \`permissions\` array`];
  }

  const violations = [];
  if (permissions.length !== 5) {
    violations.push(
      `${CAPABILITY_FILE}: the capability must declare exactly the five reviewed permissions (\`${REVIEWED_PERMISSIONS.join('`, `')}\`), found ${permissions.length} entries`,
    );
  }

  const granted = new Set();
  permissions.forEach((entry, index) => {
    if (typeof entry === 'string') {
      if (!REVIEWED_PLAIN_PERMISSIONS.includes(entry)) {
        violations.push(
          `${CAPABILITY_FILE}: permissions[${index}] declares \`${entry}\`, which is outside the reviewed five; no plugin permission other than \`core:default\` and \`log:default\` is a plain string`,
        );
        return;
      }
      if (granted.has(entry)) violations.push(`${CAPABILITY_FILE}: permissions[${index}] repeats \`${entry}\``);
      granted.add(entry);
      return;
    }

    if (!isPlainObject(entry) || typeof entry.identifier !== 'string') {
      violations.push(`${CAPABILITY_FILE}: permissions[${index}] is neither a permission identifier nor an object carrying one`);
      return;
    }
    if (entry.identifier === 'fs:scope') {
      violations.push(
        `${CAPABILITY_FILE}: permissions[${index}] declares the global \`fs:scope\`; the capability grants scope per command, and a global scope would authorize every enabled command`,
      );
      return;
    }
    if (!REVIEWED_COMMAND_PERMISSIONS.includes(entry.identifier)) {
      violations.push(
        `${CAPABILITY_FILE}: permissions[${index}] declares \`${entry.identifier}\`, which is outside the reviewed five; \`opener:*\` and every other plugin permission must stay absent`,
      );
      return;
    }
    if (granted.has(entry.identifier)) violations.push(`${CAPABILITY_FILE}: permissions[${index}] repeats \`${entry.identifier}\``);
    granted.add(entry.identifier);

    if (!Array.isArray(entry.allow) || entry.allow.length === 0) {
      violations.push(`${CAPABILITY_FILE}: permissions[${index}] \`${entry.identifier}\` must carry a non-empty \`allow\` scope list`);
      return;
    }
    entry.allow.forEach((scopeEntry, scopeIndex) => {
      const pattern = typeof scopeEntry === 'string' ? scopeEntry : scopeEntry?.path;
      if (typeof pattern !== 'string') {
        violations.push(
          `${CAPABILITY_FILE}: permissions[${index}] \`${entry.identifier}\` allow[${scopeIndex}] is not a path string or \`{ "path": ... }\` object`,
        );
        return;
      }
      if (pattern.includes('\\')) {
        violations.push(`${CAPABILITY_FILE}: \`${entry.identifier}\` allow[${scopeIndex}] \`${pattern}\` uses a backslash separator`);
        return;
      }
      if (pattern.split('/').includes('..')) {
        violations.push(`${CAPABILITY_FILE}: \`${entry.identifier}\` allow[${scopeIndex}] \`${pattern}\` contains a parent-directory segment`);
        return;
      }
      const normalized = pattern.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
      if (normalized !== CACHE_ROOT && !normalized.startsWith(`${CACHE_ROOT}/`)) {
        violations.push(
          `${CAPABILITY_FILE}: \`${entry.identifier}\` allow[${scopeIndex}] \`${pattern}\` is outside \`${CACHE_ROOT}\`; every filesystem scope must stay inside the cache directory`,
        );
      }
    });
  });

  for (const permission of REVIEWED_PERMISSIONS) {
    if (!granted.has(permission)) {
      violations.push(`${CAPABILITY_FILE}: the capability must keep \`${permission}\``);
    }
  }

  return violations;
}

/** The asset protocol serves exactly the cached image descendants. */
export function assetScopeViolations(config) {
  const violations = [];
  const assetProtocol = config?.app?.security?.assetProtocol;
  if (!isPlainObject(assetProtocol)) {
    return [`${CONFIG_FILE}: app.security.assetProtocol must be present; it is the only gate that decides which local files \`convertFileSrc\` may serve`];
  }
  if (assetProtocol.enable !== true) {
    violations.push(`${CONFIG_FILE}: app.security.assetProtocol.enable must stay \`true\``);
  }
  const scope = assetProtocol.scope;
  if (!Array.isArray(scope)) {
    return [...violations, `${CONFIG_FILE}: app.security.assetProtocol.scope must be an array`];
  }
  if (scope.length !== 1) {
    violations.push(`${CONFIG_FILE}: app.security.assetProtocol.scope must hold exactly one entry, found ${scope.length}`);
  }
  if (scope.length !== 1 || scope[0] !== CACHE_DESCENDANTS) {
    violations.push(
      `${CONFIG_FILE}: app.security.assetProtocol.scope must be exactly ${JSON.stringify([CACHE_DESCENDANTS])}, found ${JSON.stringify(scope)}`,
    );
  }
  return violations;
}

/** The removed scaffold command and plugin stay removed from source and manifests. */
export function scaffoldMarkerViolations({ rustSources, packageText, cargoText }) {
  const violations = [];
  for (const { file, text } of rustSources) {
    if (/\bgreet\b/.test(text)) {
      violations.push(`${file}: still declares or calls the removed scaffold \`greet\` command`);
    }
    if (/opener/i.test(text)) {
      violations.push(`${file}: still references the removed opener plugin`);
    }
  }
  if (/plugin-opener/i.test(packageText)) {
    violations.push(`${PACKAGE_FILE}: still lists the removed \`@tauri-apps/plugin-opener\` dependency`);
  }
  if (/\bgreet\b/i.test(packageText)) {
    violations.push(`${PACKAGE_FILE}: still carries the removed \`greet\` scaffold command`);
  }
  if (/tauri-plugin-opener/i.test(cargoText)) {
    violations.push(`${CARGO_FILE}: still lists the removed \`tauri-plugin-opener\` dependency`);
  }
  if (/\bgreet\b/i.test(cargoText)) {
    violations.push(`${CARGO_FILE}: still carries the removed \`greet\` scaffold command`);
  }
  return violations;
}

/** A deep-equality comparison that keeps both source lists in their declared order. */
function sameSources(left, right) {
  return left.length === right.length && left.every((source, index) => source === right[index]);
}

/**
 * The smoke configuration may change exactly three keys: the frontend directory,
 * the build command and the CSP. Its CSP must be the production policy plus the
 * single loopback fixture origin on `connect-src` and `img-src`, so the delta the
 * smoke proves cannot drift into a wider policy.
 */
export function smokeDeltaViolations({ productionCsp, smokeConfig }) {
  if (!isPlainObject(smokeConfig)) {
    return [`${SMOKE_CONFIG_FILE}: must be a JSON object`];
  }
  if (typeof productionCsp !== 'string' || productionCsp.trim() === '') {
    // The production policy itself is already reported by `cspViolations`.
    return [];
  }

  const violations = [];
  const topLevel = Object.keys(smokeConfig).filter((key) => key !== '$schema').sort();
  if (JSON.stringify(topLevel) !== JSON.stringify(['app', 'build'])) {
    violations.push(
      `${SMOKE_CONFIG_FILE}: may override only \`build\` and \`app\`, found ${JSON.stringify(Object.keys(smokeConfig).filter((key) => key !== '$schema'))}`,
    );
  }
  if (JSON.stringify(Object.keys(smokeConfig.build ?? {}).sort()) !== JSON.stringify(['beforeBuildCommand', 'frontendDist'])) {
    violations.push(`${SMOKE_CONFIG_FILE}: build may carry only \`frontendDist\` and \`beforeBuildCommand\``);
  }
  if (smokeConfig.build?.frontendDist !== '../dist-smoke') {
    violations.push(`${SMOKE_CONFIG_FILE}: build.frontendDist must be \`../dist-smoke\`, found ${describe(smokeConfig.build?.frontendDist)}`);
  }
  if (smokeConfig.build?.beforeBuildCommand !== 'pnpm build:smoke') {
    violations.push(`${SMOKE_CONFIG_FILE}: build.beforeBuildCommand must be \`pnpm build:smoke\`, found ${describe(smokeConfig.build?.beforeBuildCommand)}`);
  }
  if (JSON.stringify(Object.keys(smokeConfig.app ?? {})) !== JSON.stringify(['security'])) {
    violations.push(`${SMOKE_CONFIG_FILE}: app may carry only \`security\``);
  }
  if (JSON.stringify(Object.keys(smokeConfig.app?.security ?? {})) !== JSON.stringify(['csp'])) {
    violations.push(`${SMOKE_CONFIG_FILE}: app.security may carry only \`csp\``);
  }

  const smokeCsp = smokeConfig.app?.security?.csp;
  if (typeof smokeCsp !== 'string' || smokeCsp.trim() === '') {
    return [...violations, `${SMOKE_CONFIG_FILE}: app.security.csp must be a non-empty string`];
  }

  const production = parseCspDirectives(productionCsp);
  const smoke = parseCspDirectives(smokeCsp);
  if (JSON.stringify([...production.keys()].sort()) !== JSON.stringify([...smoke.keys()].sort())) {
    violations.push(`${SMOKE_CONFIG_FILE}: the smoke policy must declare exactly the production directives`);
    return violations;
  }

  for (const [directive, expected] of production) {
    const actual = smoke.get(directive);
    const loopbackAllowed = directive === 'img-src' || directive === 'connect-src';
    const expectedWithLoopback = loopbackAllowed ? [...expected, LOOPBACK_SMOKE_ORIGIN] : expected;
    if (!sameSources(actual, expectedWithLoopback)) {
      violations.push(
        `${SMOKE_CONFIG_FILE}: ${directive} must be exactly the production sources${loopbackAllowed ? ` plus \`${LOOPBACK_SMOKE_ORIGIN}\`` : ''}, found \`${actual.join(' ')}\``,
      );
    }
  }

  for (const [directive, sources] of smoke) {
    for (const source of sources) {
      if (source.includes('*') && source !== LOOPBACK_SMOKE_ORIGIN && !REVIEWED_HOST_WILDCARDS.includes(source)) {
        violations.push(`${SMOKE_CONFIG_FILE}: ${directive} admits the unreviewed wildcard \`${source}\``);
      }
      if (source.toLowerCase() === "'unsafe-eval'") {
        violations.push(`${SMOKE_CONFIG_FILE}: ${directive} admits \`'unsafe-eval'\``);
      }
    }
  }

  return violations;
}

/** The complete checked-in read, so a test failure names every offending surface. */
export function checkedInSecurity() {
  const packageText = readText(PACKAGE_FILE);
  const cargoText = readText(CARGO_FILE);
  let packageJson;
  try {
    packageJson = JSON.parse(packageText);
  } catch (error) {
    throw new Error(`${PACKAGE_FILE} is not valid JSON: ${error.message}`);
  }

  return {
    packageJson,
    packageText,
    cargoText,
    cargo: parseCargoManifest(cargoText),
    config: readJson(CONFIG_FILE),
    capability: readJson(CAPABILITY_FILE),
    html: readText(HTML_FILE),
    smokeConfig: readJson(SMOKE_CONFIG_FILE),
    rustSources: readRustSources(),
  };
}

/** Every guarded surface, aggregated so one run reports all violations. */
export function securityViolations(state) {
  const security = state.config?.app?.security;
  const violations = [
    ...identityViolations(state),
    ...cspViolations(security?.csp),
    ...devCspViolations(security?.devCsp, security?.csp),
    ...capabilityViolations(state.capability),
    ...assetScopeViolations(state.config),
    ...scaffoldMarkerViolations(state),
    ...smokeDeltaViolations({ productionCsp: security?.csp, smokeConfig: state.smokeConfig }),
  ];
  if (security?.dangerousDisableAssetCspModification !== undefined) {
    violations.push(
      `${CONFIG_FILE}: app.security.dangerousDisableAssetCspModification must stay unset; it disables the nonce/hash injection the bundle needs`,
    );
  }
  return violations;
}

/** A reviewed-shape state for the negative cases below; mutated by `violationsAfter`. */
export function validSecurityState() {
  const packageJson = {
    name: EXPECTED_IDENTITY.packageName,
    dependencies: { '@tauri-apps/api': '^2.11.1', '@tauri-apps/plugin-fs': '^2.5.1' },
  };
  return {
    packageJson,
    packageText: JSON.stringify(packageJson),
    cargoText: '[package]\nname = "anywear"\ndescription = "AnyWear desktop and mobile client"\nauthors = ["AnyWear"]\n[lib]\nname = "anywear_lib"\n',
    cargo: {
      package: {
        name: EXPECTED_IDENTITY.crateName,
        description: EXPECTED_IDENTITY.crateDescription,
        authors: [...EXPECTED_IDENTITY.crateAuthors],
      },
      lib: { name: EXPECTED_IDENTITY.libraryName },
    },
    config: {
      productName: EXPECTED_IDENTITY.productName,
      identifier: EXPECTED_IDENTITY.identifier,
      app: {
        windows: [{ title: EXPECTED_IDENTITY.windowTitle }],
        security: {
          csp: PRODUCTION_CSP,
          devCsp: DEVELOPMENT_CSP,
          assetProtocol: { enable: true, scope: [CACHE_DESCENDANTS] },
        },
      },
      bundle: {
        publisher: EXPECTED_IDENTITY.publisher,
        copyright: EXPECTED_IDENTITY.copyright,
        category: EXPECTED_IDENTITY.category,
        shortDescription: EXPECTED_IDENTITY.shortDescription,
        longDescription: EXPECTED_IDENTITY.longDescription,
      },
    },
    capability: {
      permissions: [
        'core:default',
        'log:default',
        { identifier: 'fs:allow-exists', allow: [{ path: CACHE_DIRECTORY }, { path: CACHE_DESCENDANTS }] },
        { identifier: 'fs:allow-mkdir', allow: [{ path: CACHE_ROOT }, { path: CACHE_DIRECTORY }] },
        { identifier: 'fs:allow-write-file', allow: [{ path: CACHE_DESCENDANTS }] },
      ],
    },
    html: '<title>AnyWear</title>',
    smokeConfig: {
      build: { frontendDist: '../dist-smoke', beforeBuildCommand: 'pnpm build:smoke' },
      app: { security: { csp: SMOKE_CSP } },
    },
    rustSources: [{ file: 'src-tauri/src/lib.rs', text: 'pub fn run() {}\n' }],
  };
}

function violationsAfter(mutate) {
  const state = structuredClone(validSecurityState());
  mutate?.(state);
  return securityViolations(state);
}

test('the checked-in Tauri security configuration, identifiers and smoke delta match the review', () => {
  assert.deepEqual(securityViolations(checkedInSecurity()), []);
});

test('the reviewed synthetic state used by the negative cases is accepted', () => {
  assert.deepEqual(violationsAfter(), []);
});

test('rejects a missing, empty, null or scheme-widened CSP and names the offending source', () => {
  for (const csp of [null, '', undefined, 42]) {
    const violations = violationsAfter((state) => {
      state.config.app.security.csp = csp;
    });
    assert.ok(violations.some((violation) => violation.includes('must be a non-empty string')), JSON.stringify(violations));
  }

  for (const source of ['http:', 'https:', 'ws:', 'wss:']) {
    const violations = cspViolations(PRODUCTION_CSP.replace('connect-src \'self\'', `connect-src ${source}`));
    assert.ok(
      violations.some((violation) => violation.includes(`\`${source}\``) && violation.includes('scheme-only')),
      `\`${source}\` must be rejected: ${JSON.stringify(violations)}`,
    );
  }
});

test('rejects unsafe-eval and any host wildcard outside the two reviewed entries', () => {
  const unsafeEval = cspViolations(PRODUCTION_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"));
  assert.ok(unsafeEval.some((violation) => violation.includes("'unsafe-eval'")));
  assert.ok(unsafeEval.some((violation) => violation.includes('script-src must be exactly')));

  for (const wildcard of ['https://*', 'https://*.example.com', 'https://example.*', '*']) {
    const violations = cspViolations(PRODUCTION_CSP.replace('font-src \'self\'', `font-src ${wildcard}`));
    assert.ok(
      violations.some((violation) => violation.includes(`\`${wildcard}\``) && violation.includes('host wildcard')),
      `\`${wildcard}\` must be rejected: ${JSON.stringify(violations)}`,
    );
  }

  // The two reviewed entries are tolerated, and `asset:`/`data:` are reviewed
  // scheme sources rather than network scheme-only sources.
  assert.deepEqual(cspViolations(PRODUCTION_CSP), []);
  const assetSources = cspViolations(PRODUCTION_CSP.replace('data: https://*.cloudfront.net', 'asset: data: https://*.cloudfront.net'));
  assert.deepEqual(assetSources, []);
});

test('rejects a script-src or style-src that is not exactly self', () => {
  for (const directive of ['script-src', 'style-src']) {
    const withInline = cspViolations(PRODUCTION_CSP.replace(`${directive} 'self'`, `${directive} 'self' 'unsafe-inline'`));
    assert.ok(withInline.some((violation) => violation.includes(`${directive} must be exactly`)), JSON.stringify(withInline));

    const removed = cspViolations(PRODUCTION_CSP.replace(`${directive} 'self'; `, ''));
    assert.ok(removed.some((violation) => violation.includes('must declare') && violation.includes(directive)), JSON.stringify(removed));
  }
});

test('rejects a dev policy that is absent, equal to production or missing a dev origin', () => {
  const absent = violationsAfter((state) => {
    delete state.config.app.security.devCsp;
  });
  assert.ok(absent.some((violation) => violation.includes('devCsp must be a non-empty string')));

  const equal = violationsAfter((state) => {
    state.config.app.security.devCsp = state.config.app.security.csp;
  });
  assert.ok(equal.some((violation) => violation.includes('must differ')));

  for (const source of ['http://localhost:1420', 'ws://localhost:1421', 'http://localhost:3000']) {
    const violations = violationsAfter((state) => {
      state.config.app.security.devCsp = state.config.app.security.devCsp.replaceAll(source, 'http://blocked.invalid');
    });
    assert.ok(
      violations.some((violation) => violation.includes(`\`${source}\``)),
      `a dev policy without \`${source}\` must be rejected: ${JSON.stringify(violations)}`,
    );
  }

  assert.deepEqual(devCspViolations(DEVELOPMENT_CSP, PRODUCTION_CSP), []);
});

test('rejects capabilities that widen permissions, drop commands or reintroduce the opener', () => {
  for (const permission of ['opener:default', 'fs:allow-read', 'shell:allow-open', 'log:allow-log']) {
    const violations = violationsAfter((state) => {
      state.capability.permissions.push(permission);
    });
    assert.ok(
      violations.some((violation) => violation.includes(`\`${permission}\``) && /outside the reviewed five|bare string/.test(violation)),
      JSON.stringify(violations),
    );
  }

  for (const identifier of REVIEWED_COMMAND_PERMISSIONS) {
    const violations = violationsAfter((state) => {
      state.capability.permissions = state.capability.permissions.filter(
        (entry) => typeof entry === 'string' || entry.identifier !== identifier,
      );
    });
    assert.ok(violations.some((violation) => violation.includes(`\`${identifier}\``) && violation.includes('must keep')));
  }

  for (const identifier of REVIEWED_PLAIN_PERMISSIONS) {
    const violations = violationsAfter((state) => {
      state.capability.permissions = state.capability.permissions.filter((entry) => entry !== identifier);
    });
    assert.ok(violations.some((violation) => violation.includes(`\`${identifier}\``) && violation.includes('must keep')));
  }
});

test('rejects any fs scope that leaves the cache, a global fs:scope, and an empty scope', () => {
  for (const path of ['$APPDATA/**', '$APPDATA', '$APPLOG/**']) {
    const violations = violationsAfter((state) => {
      state.capability.permissions.find((entry) => entry.identifier === 'fs:allow-exists').allow.push({ path });
    });
    assert.ok(
      violations.some((violation) => violation.includes(`\`${path}\``) && violation.includes('outside')),
      `\`${path}\` must be rejected: ${JSON.stringify(violations)}`,
    );
  }

  for (const scope of [
    { identifier: 'fs:scope', allow: [{ path: CACHE_DESCENDANTS }] },
    { identifier: 'fs:scope', allow: [{ path: '$APPDATA/**' }] },
  ]) {
    const violations = violationsAfter((state) => {
      state.capability.permissions.push(scope);
    });
    assert.ok(violations.some((violation) => violation.includes('global `fs:scope`')), JSON.stringify(violations));
  }

  const emptied = violationsAfter((state) => {
    state.capability.permissions.find((entry) => entry.identifier === 'fs:allow-write-file').allow = [];
  });
  assert.ok(emptied.some((violation) => violation.includes('must carry a non-empty `allow` scope list')));

  const backslash = violationsAfter((state) => {
    state.capability.permissions.find((entry) => entry.identifier === 'fs:allow-exists').allow = [{ path: '$APPDATA\\cache\\images' }];
  });
  assert.ok(backslash.some((violation) => violation.includes('backslash')), JSON.stringify(backslash));
});

test('rejects an asset scope other than exactly the cached image descendants', () => {
  for (const scope of [['$APPDATA/**'], [CACHE_DIRECTORY], [CACHE_DESCENDANTS, CACHE_DIRECTORY], []]) {
    const violations = violationsAfter((state) => {
      state.config.app.security.assetProtocol.scope = scope;
    });
    assert.ok(violations.some((violation) => violation.includes('assetProtocol.scope must be exactly')), JSON.stringify(violations));
  }

  const disabled = violationsAfter((state) => {
    state.config.app.security.assetProtocol.enable = false;
  });
  assert.ok(disabled.some((violation) => violation.includes('must stay `true`')));

  const unsafeModification = violationsAfter((state) => {
    state.config.app.security.dangerousDisableAssetCspModification = true;
  });
  assert.ok(unsafeModification.some((violation) => violation.includes('dangerousDisableAssetCspModification')));
});

test('rejects each scaffold identity field by its parsed value', () => {
  const mutations = [
    [(state) => { state.packageJson.name = 'tauri-app'; }, 'package.json'],
    [(state) => { state.cargo.package.name = 'tauri-app'; }, '[package] name'],
    [(state) => { state.cargo.package.description = 'A Tauri App'; }, 'description'],
    [(state) => { state.cargo.package.authors = ['you']; }, 'authors'],
    [(state) => { state.cargo.lib.name = 'tauri_app_lib'; }, '[lib] name'],
    [(state) => { state.config.productName = 'tauri-app'; }, 'productName'],
    [(state) => { state.config.app.windows[0].title = 'tauri-app'; }, 'app.windows[0].title'],
    [(state) => { state.config.identifier = 'com.example.app'; }, 'identifier'],
    [(state) => { state.config.bundle.publisher = 'example'; }, 'bundle.publisher'],
    [(state) => { state.config.bundle.copyright = 'Copyright'; }, 'bundle.copyright'],
    [(state) => { state.config.bundle.category = 'Other'; }, 'bundle.category'],
    [(state) => { state.config.bundle.shortDescription = 'Starter'; }, 'bundle.shortDescription'],
    [(state) => { state.config.bundle.longDescription = 'Starter app'; }, 'bundle.longDescription'],
    [(state) => { state.html = '<title>Tauri + React + Typescript</title>'; }, '<title>'],
  ];
  for (const [mutate, marker] of mutations) {
    const violations = violationsAfter(mutate);
    assert.ok(violations.some((violation) => violation.includes(marker)), `${marker} must be rejected: ${JSON.stringify(violations)}`);
  }

  assert.deepEqual(parseCargoManifest(validSecurityState().cargoText), validSecurityState().cargo);
});

test('rejects the removed greet command and opener plugin in source and manifests', () => {
  const greet = violationsAfter((state) => {
    state.rustSources.push({ file: 'src-tauri/src/lib.rs', text: '#[tauri::command]\nfn greet(name: &str) -> String { name.into() }\n' });
  });
  assert.ok(greet.some((violation) => violation.includes('`greet`')));

  const openerSource = violationsAfter((state) => {
    state.rustSources.push({ file: 'src-tauri/src/lib.rs', text: '.plugin(tauri_plugin_opener::init())' });
  });
  assert.ok(openerSource.some((violation) => violation.includes('opener')));

  const openerCargo = violationsAfter((state) => {
    state.cargoText = `${state.cargoText}tauri-plugin-opener = "2"\n`;
  });
  assert.ok(openerCargo.some((violation) => violation.includes('tauri-plugin-opener')));

  const openerPackage = violationsAfter((state) => {
    state.packageJson.dependencies['@tauri-apps/plugin-opener'] = '^2.5.4';
    state.packageText = JSON.stringify(state.packageJson);
  });
  assert.ok(openerPackage.some((violation) => violation.includes('@tauri-apps/plugin-opener')));
});

test('rejects a smoke policy whose delta grows, shrinks or moves', () => {
  const missingImgLoopback = violationsAfter((state) => {
    const smoke = state.smokeConfig.app.security.csp;
    state.smokeConfig.app.security.csp = smoke.replace(
      'https://*.s3.ap-east-1.amazonaws.com http://127.0.0.1:*; connect-src',
      'https://*.s3.ap-east-1.amazonaws.com; connect-src',
    );
  });
  assert.ok(
    missingImgLoopback.some((violation) => violation.includes('img-src') && violation.includes('http://127.0.0.1:*')),
    JSON.stringify(missingImgLoopback),
  );

  const missingConnectLoopback = violationsAfter((state) => {
    state.smokeConfig.app.security.csp = state.smokeConfig.app.security.csp.replace(
      'https://cognito-idp.ap-east-1.amazonaws.com http://127.0.0.1:*',
      'https://cognito-idp.ap-east-1.amazonaws.com',
    );
  });
  assert.ok(missingConnectLoopback.some((violation) => violation.includes('connect-src')));

  const extraOrigin = violationsAfter((state) => {
    state.smokeConfig.app.security.csp = state.smokeConfig.app.security.csp.replace(
      'font-src \'self\';',
      'font-src \'self\' http://evil.invalid;',
    );
  });
  assert.ok(extraOrigin.some((violation) => violation.includes('font-src')));

  const extraOverride = violationsAfter((state) => {
    state.smokeConfig.build.devUrl = 'http://127.0.0.1:38471';
  });
  assert.ok(extraOverride.some((violation) => violation.includes('build may carry only')));

  const changedDist = violationsAfter((state) => {
    state.smokeConfig.build.frontendDist = '../dist';
  });
  assert.ok(changedDist.some((violation) => violation.includes('build.frontendDist')));

  const extraSecurityKey = violationsAfter((state) => {
    state.smokeConfig.app.security.devCsp = PRODUCTION_CSP;
  });
  assert.ok(extraSecurityKey.some((violation) => violation.includes('app.security may carry only')));
});

test('an unreadable or unparsable guarded file fails instead of passing silently', () => {
  assert.throws(() => readText('src-tauri/does-not-exist.json'), /cannot be read/);
  assert.throws(() => readJson(PACKAGE_FILE.replace('package.json', 'package.json.missing')), /cannot be read/);
});
