// Tauri filesystem-scope guard for the image cache ADR 0003 owns.
//
// `src-tauri/capabilities/default.json` names the filesystem commands the webview
// may call and the per-command allow lists those commands match;
// `src-tauri/tauri.conf.json` names the directory the asset protocol may serve
// back to the webview. The capability is deliberately five entries — two
// non-filesystem permissions plus the three commands `src/components/CachedImage.tsx`
// calls — and every filesystem scope is confined to `$APPDATA/cache`. A later edit
// that widens a scope, re-adds a global `fs:scope` or drops a load-bearing command
// must fail here rather than at runtime under a packaged build.
//
// The scope patterns are compared as unresolved strings: `$APPDATA` is never
// expanded to a directory, so Linux CI and Windows agree and no application
// identity is needed. A `\` separator is rejected rather than normalized, because
// macOS and Linux read it as an ordinary filename character, so a Windows spelling
// the guard accepted would authorize nothing at runtime.
//
// Run with `pnpm run test:run`, which includes this file in its `node --test` list.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

export const CACHE_ROOT = '$APPDATA/cache';
export const CACHE_DIRECTORY = '$APPDATA/cache/images';
export const CACHE_DESCENDANTS = `${CACHE_DIRECTORY}/**`;
export const ASSET_SCOPE = [CACHE_DESCENDANTS];
export const CAPABILITY_FILE = 'src-tauri/capabilities/default.json';
export const CONFIG_FILE = 'src-tauri/tauri.conf.json';
export const CAPABILITIES_DIRECTORY = 'src-tauri/capabilities';

// The two non-filesystem permissions the capability keeps: `core:default` carries
// the path/IPC commands `appDataDir`, `join` and `convertFileSrc` use, and
// `log:default` is the console bridge in `src/main.tsx`.
const PLAIN_PERMISSIONS = ['core:default', 'log:default'];

// The three filesystem commands `src/components/CachedImage.tsx` calls, each with
// exactly the allow list its call site needs. `exists` probes the cache directory
// and the file, never the bare `$APPDATA/cache`; `mkdir` may validate the ancestor
// directory, so it keeps the bare cache entry; `write-file` only writes descendants.
export const COMMAND_PERMISSIONS = {
  'fs:allow-exists': [CACHE_DIRECTORY, CACHE_DESCENDANTS],
  'fs:allow-mkdir': [CACHE_ROOT, CACHE_DIRECTORY],
  'fs:allow-write-file': [CACHE_DESCENDANTS],
};

// Why each command permission is load-bearing, so a missing one fails with the
// consequence rather than only the name.
const COMMAND_PURPOSE = {
  'fs:allow-exists': 'without it `exists()` rejects at the IPC layer and the cache silently stops being read',
  'fs:allow-mkdir': 'without it `mkdir()` rejects and the cache directory is never created',
  'fs:allow-write-file': 'without it `writeFile()` rejects at the IPC layer and the cache silently stops being written',
};

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const capabilitiesDirectory = join(repositoryRoot, CAPABILITIES_DIRECTORY);
const capabilityPath = join(repositoryRoot, CAPABILITY_FILE);
const configPath = join(repositoryRoot, CONFIG_FILE);

/** `JSON.parse` with the file named, so a truncated document fails the guard loudly. */
export function parseConfiguration(text, file) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
}

/** Read and parse one guarded configuration file; a missing file throws. */
export function readConfiguration(path, file) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`${file} cannot be read: ${error.message}`);
  }
  return parseConfiguration(text, file);
}

/** The checked-in inputs: both parsed documents and every entry under `capabilities/`. */
function checkedInConfiguration() {
  return {
    capability: readConfiguration(capabilityPath, CAPABILITY_FILE),
    config: readConfiguration(configPath, CONFIG_FILE),
    capabilityFiles: readdirSync(capabilitiesDirectory).sort(),
  };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value) {
  return typeof value === 'string' ? `\`${value}\`` : JSON.stringify(value);
}

/** Whether an unresolved pattern stays inside `$APPDATA/cache`. */
export function isInsideCacheRoot(pattern) {
  return pattern === CACHE_ROOT || pattern.startsWith(`${CACHE_ROOT}/`);
}

/**
 * One scope entry as an unresolved pattern, or a violation when the entry is not
 * the string or `{ "path": ... }` shape Tauri accepts. Only a separator spelling
 * is normalized — repeated `/` collapsed and a trailing `/` removed — and a `\`
 * is rejected outright.
 */
function readScopeEntry(entry, file, label, index) {
  let pattern;
  if (typeof entry === 'string') {
    pattern = entry;
  } else if (isPlainObject(entry)) {
    const keys = Object.keys(entry);
    if (keys.length !== 1 || keys[0] !== 'path' || typeof entry.path !== 'string') {
      return {
        violation: `${file}: ${label}[${index}] entry ${describe(entry)} must be a path string or a \`{ "path": ... }\` object carrying no other key`,
      };
    }
    pattern = entry.path;
  } else {
    return {
      violation: `${file}: ${label}[${index}] entry ${describe(entry)} must be a path string or a \`{ "path": ... }\` object`,
    };
  }

  if (pattern.includes('\\')) {
    return {
      violation: `${file}: ${label}[${index}] entry \`${pattern}\` uses a backslash as a path separator; macOS and Linux read it as a literal filename character, so the entry must be spelled with \`/\``,
    };
  }

  // The pattern is compared unresolved, so a parent-directory segment is not
  // normalized away here; Tauri would expand it at runtime and could escape the
  // cache root the literal prefix still matches.
  if (pattern.split('/').includes('..')) {
    return {
      violation: `${file}: ${label}[${index}] entry \`${pattern}\` contains a parent-directory segment; Tauri resolves \`..\` at runtime, so the entry could leave \`${CACHE_ROOT}\``,
    };
  }

  return { pattern: pattern.replace(/\/{2,}/g, '/').replace(/\/+$/, '') };
}

/**
 * Reports every way one command's allow list departs from its reviewed list: a
 * missing entry, a repeated entry, an unreviewed entry inside `$APPDATA/cache`, or
 * an entry outside it.
 */
function validateCommandScope({ identifier, patterns, file, label }) {
  const violations = [];
  const reviewed = COMMAND_PERMISSIONS[identifier];
  const remaining = [...patterns];
  for (const expected of reviewed) {
    const at = remaining.indexOf(expected);
    if (at < 0) {
      violations.push(
        `${file}: ${label} for \`${identifier}\` is missing \`${expected}\`; ${identifier} must keep exactly the reviewed allow list (\`${reviewed.join('`, `')}\`) because the cache calls it with those paths`,
      );
    } else {
      remaining.splice(at, 1);
    }
  }
  for (const pattern of remaining) {
    if (reviewed.includes(pattern)) {
      violations.push(`${file}: ${label} for \`${identifier}\` repeats \`${pattern}\``);
    } else if (isInsideCacheRoot(pattern)) {
      violations.push(
        `${file}: ${label} for \`${identifier}\` adds \`${pattern}\`, which is not part of the reviewed allow list (\`${reviewed.join('`, `')}\`); widening a command's grant within the cache still needs a reviewed change`,
      );
    } else {
      violations.push(
        `${file}: ${label} for \`${identifier}\` entry \`${pattern}\` is outside \`${CACHE_ROOT}\`; the only allowed root is the cache directory`,
      );
    }
  }
  return violations;
}

/** Every way the parsed capability departs from the reviewed five-entry shape. */
export function validateCapability(capability) {
  const violations = [];
  const permissions = capability?.permissions;
  if (!Array.isArray(permissions)) {
    return [`${CAPABILITY_FILE}: the capability must declare a \`permissions\` array`];
  }

  if (permissions.length !== 5) {
    violations.push(
      `${CAPABILITY_FILE}: the capability must declare exactly the five reviewed permissions (\`${PLAIN_PERMISSIONS.join('`, `')}\` plus \`${Object.keys(COMMAND_PERMISSIONS).join('`, `')}\`), found ${permissions.length} entries`,
    );
  }

  const plain = [];
  const commands = [];
  permissions.forEach((entry, index) => {
    if (typeof entry === 'string') {
      if (PLAIN_PERMISSIONS.includes(entry)) {
        plain.push(entry);
        return;
      }
      if (entry.startsWith('fs:')) {
        violations.push(
          `${CAPABILITY_FILE}: permissions[${index}] declares \`${entry}\` as a bare string; the filesystem commands must be objects carrying their own \`allow\` scope`,
        );
        return;
      }
      violations.push(
        `${CAPABILITY_FILE}: permissions[${index}] declares \`${entry}\`, which is outside the reviewed five (\`${[...PLAIN_PERMISSIONS, ...Object.keys(COMMAND_PERMISSIONS)].join('`, `')}\`)`,
      );
      return;
    }

    if (!isPlainObject(entry) || typeof entry.identifier !== 'string') {
      violations.push(`${CAPABILITY_FILE}: permissions[${index}] is neither a permission identifier nor an object carrying one`);
      return;
    }

    if (entry.identifier === 'fs:scope') {
      violations.push(
        `${CAPABILITY_FILE}: permissions[${index}] declares the global \`fs:scope\`; the capability grants scope per command instead, and a global scope would authorize every enabled command`,
      );
      return;
    }

    if (!Object.hasOwn(COMMAND_PERMISSIONS, entry.identifier)) {
      violations.push(
        `${CAPABILITY_FILE}: permissions[${index}] declares \`${entry.identifier}\`, which is outside the filesystem command allowlist (\`${Object.keys(COMMAND_PERMISSIONS).join('`, `')}\`)`,
      );
      return;
    }

    commands.push({ entry, index });
  });

  for (const permission of PLAIN_PERMISSIONS) {
    if (!plain.includes(permission)) {
      violations.push(`${CAPABILITY_FILE}: the capability must keep \`${permission}\``);
    }
  }
  for (const permission of Object.keys(COMMAND_PERMISSIONS)) {
    if (!commands.some(({ entry }) => entry.identifier === permission)) {
      violations.push(`${CAPABILITY_FILE}: the capability must name \`${permission}\`; ${COMMAND_PURPOSE[permission]}`);
    }
  }

  for (const { entry, index } of commands) {
    for (const key of Object.keys(entry)) {
      if (!['identifier', 'allow'].includes(key)) {
        violations.push(
          `${CAPABILITY_FILE}: permissions[${index}] \`${entry.identifier}\` carries \`${key}\`; a command permission may carry only \`identifier\` and its \`allow\` list`,
        );
      }
    }

    const label = `permissions[${index}] \`${entry.identifier}\` allow`;
    if (!Array.isArray(entry.allow)) {
      violations.push(`${CAPABILITY_FILE}: ${label} must be an array of path entries`);
      continue;
    }
    const patterns = [];
    entry.allow.forEach((scopeEntry, scopeIndex) => {
      const read = readScopeEntry(scopeEntry, CAPABILITY_FILE, label, scopeIndex);
      if (read.violation) violations.push(read.violation);
      else patterns.push(read.pattern);
    });
    violations.push(...validateCommandScope({ identifier: entry.identifier, patterns, file: CAPABILITY_FILE, label }));
  }

  return violations;
}

/** Every way the parsed asset-protocol configuration departs from the reviewed single entry. */
export function validateAssetScope(config) {
  const violations = [];
  const assetProtocol = config?.app?.security?.assetProtocol;
  if (!isPlainObject(assetProtocol)) {
    return [`${CONFIG_FILE}: app.security.assetProtocol must be present; it is the only gate that decides which local files \`convertFileSrc\` may serve`];
  }

  if (assetProtocol.enable !== true) {
    violations.push(`${CONFIG_FILE}: app.security.assetProtocol.enable must stay \`true\`, found ${describe(assetProtocol.enable)}`);
  }

  if (!Array.isArray(assetProtocol.scope)) {
    return [...violations, `${CONFIG_FILE}: app.security.assetProtocol.scope must be an array holding the single image-cache entry \`${CACHE_DESCENDANTS}\``];
  }

  if (assetProtocol.scope.length !== ASSET_SCOPE.length) {
    violations.push(
      `${CONFIG_FILE}: app.security.assetProtocol.scope must hold exactly one entry, \`${CACHE_DESCENDANTS}\`; found ${assetProtocol.scope.length}`,
    );
  }

  const patterns = [];
  assetProtocol.scope.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      violations.push(
        `${CONFIG_FILE}: app.security.assetProtocol.scope[${index}] entry ${describe(entry)} must be a path string; the asset protocol accepts resolved scope strings`,
      );
      return;
    }
    const read = readScopeEntry(entry, CONFIG_FILE, 'app.security.assetProtocol.scope', index);
    if (read.violation) violations.push(read.violation);
    else patterns.push(read.pattern);
  });

  for (const expected of ASSET_SCOPE) {
    if (!patterns.includes(expected)) {
      violations.push(`${CONFIG_FILE}: app.security.assetProtocol.scope is missing \`${expected}\`; the asset protocol must serve exactly the cached image files`);
    }
  }
  for (const pattern of patterns) {
    if (pattern === CACHE_DESCENDANTS) continue;
    if (isInsideCacheRoot(pattern)) {
      violations.push(`${CONFIG_FILE}: app.security.assetProtocol.scope[?] entry \`${pattern}\` is not the reviewed single entry \`${CACHE_DESCENDANTS}\``);
    } else {
      violations.push(`${CONFIG_FILE}: app.security.assetProtocol.scope[?] entry \`${pattern}\` is outside \`${CACHE_ROOT}\`; the asset protocol must never serve files outside the image cache`);
    }
  }

  return violations;
}

/**
 * Every way the two parsed documents depart from the reviewed boundary: exactly one
 * capability file, the five reviewed permissions with `$APPDATA/cache`-confined
 * per-command scopes, and an asset protocol whose scope is the single image-cache
 * descendant entry.
 */
export function validateTauriFsScope({ capability, config, capabilityFiles = ['default.json'] }) {
  const violations = [];

  // Tauri loads every capability file in the directory, so a second file is a
  // grant path neither guarded file shows.
  const files = [...capabilityFiles].sort();
  if (!files.includes('default.json')) {
    violations.push(`${CAPABILITIES_DIRECTORY}: \`default.json\` is missing; the guarded capability cannot be deleted or renamed away`);
  }
  for (const file of files) {
    if (file === 'default.json') continue;
    violations.push(`${CAPABILITIES_DIRECTORY}: \`${file}\` is a second capability file; Tauri enables every capability file in this directory, so it could grant a scope neither guarded file shows`);
  }

  violations.push(...validateCapability(capability));
  violations.push(...validateAssetScope(config));

  return violations;
}

/** A capability in the delivered shape, for the negative cases below. */
function validCapability() {
  return {
    $schema: '../gen/schemas/desktop-schema.json',
    identifier: 'default',
    description: 'Capability for the main window',
    windows: ['main'],
    permissions: [
      'core:default',
      'log:default',
      {
        identifier: 'fs:allow-exists',
        allow: [{ path: CACHE_DIRECTORY }, { path: CACHE_DESCENDANTS }],
      },
      {
        identifier: 'fs:allow-mkdir',
        allow: [{ path: CACHE_ROOT }, { path: CACHE_DIRECTORY }],
      },
      {
        identifier: 'fs:allow-write-file',
        allow: [{ path: CACHE_DESCENDANTS }],
      },
    ],
  };
}

/** A `tauri.conf.json` in the delivered shape, for the negative cases below. */
function validConfig() {
  return {
    $schema: 'https://schema.tauri.app/config/2',
    productName: 'AnyWear',
    version: '0.1.0',
    identifier: 'com.anywear.app',
    app: {
      windows: [{ title: 'AnyWear', width: 800, height: 600 }],
      security: {
        csp: 'default-src \'self\'',
        assetProtocol: {
          enable: true,
          scope: [...ASSET_SCOPE],
        },
      },
    },
  };
}

/** The command permission object a negative case mutates. */
function commandPermissionOf(capability, identifier) {
  return capability.permissions.find((entry) => isPlainObject(entry) && entry.identifier === identifier);
}

/** Runs the validator on a fresh valid pair after `mutate` edits it. */
function violationsAfter(mutate) {
  const capability = structuredClone(validCapability());
  const config = structuredClone(validConfig());
  mutate?.({ capability, config });
  return validateTauriFsScope({ capability, config, capabilityFiles: ['default.json'] });
}

test('the checked-in capability grants the five reviewed permissions inside the image cache', () => {
  assert.deepEqual(validateTauriFsScope(checkedInConfiguration()), []);
});

test('a synthetic reviewed pair is accepted, including repeated and trailing separators', () => {
  assert.deepEqual(violationsAfter(), []);

  const capability = structuredClone(validCapability());
  commandPermissionOf(capability, 'fs:allow-exists').allow = [
    { path: '$APPDATA/cache//images/' },
    { path: CACHE_DESCENDANTS },
  ];
  assert.deepEqual(
    validateTauriFsScope({ capability, config: validConfig(), capabilityFiles: ['default.json'] }),
    [],
  );
});

test('rejects any allow entry outside the cache root and names it', () => {
  for (const path of ['$APPDATA/**', '$APPDATA', '$APPDATA/*', '$APPLOG/**']) {
    const violations = violationsAfter(({ capability }) => {
      commandPermissionOf(capability, 'fs:allow-write-file').allow.push({ path });
    });
    assert.equal(violations.length, 1, `\`${path}\` must be the only violation, got ${JSON.stringify(violations)}`);
    assert.ok(violations[0].includes(`\`${path}\``), `the violation must name \`${path}\`: ${violations[0]}`);
    assert.match(violations[0], /outside `\$APPDATA\/cache`/);
  }
});

test('rejects a parent-directory segment that would escape the cache root at runtime', () => {
  const violations = violationsAfter(({ capability, config }) => {
    commandPermissionOf(capability, 'fs:allow-write-file').allow.push({ path: '$APPDATA/cache/images/../..' });
    config.app.security.assetProtocol.scope = ['$APPDATA/cache/images/../../secrets/**'];
  });
  assert.equal(
    violations.filter((violation) => violation.includes('parent-directory segment')).length,
    2,
    JSON.stringify(violations),
  );
  assert.ok(violations.some((violation) => violation.includes(`missing \`${CACHE_DESCENDANTS}\``)));
});

test('rejects widening a command scope even when the new path stays inside the cache root', () => {
  for (const path of [CACHE_ROOT, '$APPDATA/cache/logs', `${CACHE_DIRECTORY}/private/**`]) {
    const violations = violationsAfter(({ capability }) => {
      commandPermissionOf(capability, 'fs:allow-exists').allow.push({ path });
    });
    assert.equal(violations.length, 1, `\`${path}\` must be the only violation, got ${JSON.stringify(violations)}`);
    assert.ok(violations[0].includes(`\`${path}\``));
    assert.match(violations[0], /not part of the reviewed allow list/);
  }
});

test('rejects replacing the reviewed scopes with a wider one', () => {
  const violations = violationsAfter(({ capability }) => {
    commandPermissionOf(capability, 'fs:allow-exists').allow = [{ path: '$APPDATA/**' }];
  });
  assert.ok(violations.some((violation) => violation.includes('`$APPDATA/**`') && violation.includes('outside')));
  assert.ok(violations.some((violation) => violation.includes('missing') && violation.includes(CACHE_DIRECTORY)));
  assert.ok(violations.some((violation) => violation.includes('missing') && violation.includes(CACHE_DESCENDANTS)));
});

test('rejects a Windows separator instead of normalizing it', () => {
  const violations = violationsAfter(({ capability, config }) => {
    commandPermissionOf(capability, 'fs:allow-exists').allow = [
      { path: '$APPDATA\\cache\\images' },
      { path: '$APPDATA\\cache\\images\\**' },
    ];
    config.app.security.assetProtocol.scope = ['$APPDATA\\cache\\images\\**'];
  });
  assert.ok(violations.some((violation) => violation.includes('$APPDATA\\cache\\images') && violation.includes('backslash')));
  assert.ok(violations.some((violation) => violation.includes('$APPDATA\\cache\\images\\**') && violation.includes('backslash')));
  // The spelling is rejected, not read as the canonical entry.
  assert.ok(violations.some((violation) => violation.includes('missing') && violation.includes(CACHE_DESCENDANTS)));
});

test('rejects a base-directory variable other than $APPDATA', () => {
  const violations = violationsAfter(({ capability, config }) => {
    commandPermissionOf(capability, 'fs:allow-exists').allow = [
      { path: '$APPLOCALDATA/cache/images' },
      { path: '$APPLOCALDATA/cache/images/**' },
    ];
    config.app.security.assetProtocol.scope = ['$APPLOCALDATA/cache/images/**'];
  });
  for (const file of [CAPABILITY_FILE, CONFIG_FILE]) {
    assert.ok(
      violations.some((violation) => violation.startsWith(file) && violation.includes('$APPLOCALDATA/cache/images') && violation.includes('outside')),
      `\`$APPLOCALDATA\` entries in ${file} must be rejected`,
    );
  }
});

test('rejects any permission outside the reviewed five', () => {
  for (const identifier of [
    'opener:default',
    'fs:allow-read',
    'fs:allow-read-file',
    'fs:allow-appdata-read',
    'shell:allow-open',
    'log:allow-log',
  ]) {
    const violations = violationsAfter(({ capability }) => {
      capability.permissions.push(identifier);
    });
    assert.ok(violations.some((violation) => violation.includes(`\`${identifier}\``)), `the violation must name \`${identifier}\``);
    assert.ok(
      violations.some((violation) => violation.includes(`\`${identifier}\``) && /outside the reviewed five|bare string/.test(violation)),
      `\`${identifier}\` must be rejected, not silently accepted: ${JSON.stringify(violations)}`,
    );
  }
});

test('rejects a global fs:scope, including one that duplicates the reviewed paths', () => {
  for (const scope of [
    { identifier: 'fs:scope', allow: [{ path: '$APPDATA/**' }] },
    { identifier: 'fs:scope', allow: [{ path: CACHE_DIRECTORY }, { path: CACHE_DESCENDANTS }] },
  ]) {
    const violations = violationsAfter(({ capability }) => {
      capability.permissions.push(scope);
    });
    assert.ok(violations.some((violation) => violation.includes('global `fs:scope`')), JSON.stringify(violations));
  }
});

test('rejects dropping any of the three filesystem commands or the two plain permissions', () => {
  for (const identifier of Object.keys(COMMAND_PERMISSIONS)) {
    const violations = violationsAfter(({ capability }) => {
      capability.permissions = capability.permissions.filter(
        (entry) => !isPlainObject(entry) || entry.identifier !== identifier,
      );
    });
    assert.ok(violations.some((violation) => violation.includes(`\`${identifier}\``)));
    assert.ok(violations.some((violation) => violation.includes('the capability must name')));
  }

  for (const identifier of PLAIN_PERMISSIONS) {
    const violations = violationsAfter(({ capability }) => {
      capability.permissions = capability.permissions.filter((entry) => entry !== identifier);
    });
    assert.ok(violations.some((violation) => violation.includes(`\`${identifier}\``) && violation.includes('must keep')));
  }
});

test('rejects a bare-string command permission that would bypass the per-command scope', () => {
  const violations = violationsAfter(({ capability }) => {
    capability.permissions = capability.permissions.map((entry) =>
      isPlainObject(entry) && entry.identifier === 'fs:allow-exists' ? entry.identifier : entry,
    );
  });
  assert.ok(violations.some((violation) => violation.includes('`fs:allow-exists` as a bare string')), JSON.stringify(violations));
});

test('rejects extra keys, wrong entry shapes and emptied allow lists', () => {
  const extraKey = violationsAfter(({ capability }) => {
    commandPermissionOf(capability, 'fs:allow-exists').deny = [{ path: `${CACHE_DIRECTORY}/private/**` }];
  });
  assert.ok(extraKey.some((violation) => violation.includes('carries `deny`')));

  const extraEntryKey = violationsAfter(({ capability }) => {
    commandPermissionOf(capability, 'fs:allow-mkdir').allow[0] = { path: CACHE_ROOT, recursive: true };
  });
  assert.ok(extraEntryKey.some((violation) => violation.includes('carrying no other key')));

  const wrongType = violationsAfter(({ capability }) => {
    commandPermissionOf(capability, 'fs:allow-write-file').allow = [42];
  });
  assert.ok(wrongType.some((violation) => violation.includes('must be a path string or a `{ "path": ... }` object')));

  const emptied = violationsAfter(({ capability }) => {
    commandPermissionOf(capability, 'fs:allow-write-file').allow = [];
  });
  assert.equal(emptied.length, 1);
  assert.ok(emptied[0].includes(`missing \`${CACHE_DESCENDANTS}\``));

  const noAllow = violationsAfter(({ capability }) => {
    delete commandPermissionOf(capability, 'fs:allow-write-file').allow;
  });
  assert.ok(noAllow.some((violation) => violation.includes('must be an array')));

  const notArray = violationsAfter(({ capability }) => {
    capability.permissions = 'core:default';
  });
  assert.deepEqual(notArray, [`${CAPABILITY_FILE}: the capability must declare a \`permissions\` array`]);
});

test('rejects any asset protocol scope that is not exactly the single image-cache entry', () => {
  for (const path of ['$APPDATA/**', '$APPDATA', '$APPDATA/*', '$APPLOG/**']) {
    const violations = violationsAfter(({ config }) => {
      config.app.security.assetProtocol.scope = [path];
    });
    assert.ok(
      violations.some((violation) => violation.includes(`\`${path}\``) && violation.includes('outside')),
      `\`${path}\` must be rejected as outside the cache root: ${JSON.stringify(violations)}`,
    );
    assert.ok(
      violations.some((violation) => violation.includes(`missing \`${CACHE_DESCENDANTS}\``)),
      `the reviewed entry must also be reported missing for \`${path}\``,
    );
  }

  for (const path of [CACHE_ROOT, CACHE_DIRECTORY, `${CACHE_DIRECTORY}/private/**`]) {
    const violations = violationsAfter(({ config }) => {
      config.app.security.assetProtocol.scope = [path];
    });
    assert.ok(
      violations.some((violation) => violation.includes(`\`${path}\``) && violation.includes('not the reviewed single entry')),
      `\`${path}\` must be rejected as unreviewed: ${JSON.stringify(violations)}`,
    );
    assert.ok(violations.some((violation) => violation.includes(`missing \`${CACHE_DESCENDANTS}\``)));
  }

  const pair = violationsAfter(({ config }) => {
    config.app.security.assetProtocol.scope = [CACHE_DIRECTORY, CACHE_DESCENDANTS];
  });
  assert.ok(pair.some((violation) => violation.includes('exactly one entry')));
  assert.ok(pair.some((violation) => violation.includes(`\`${CACHE_DIRECTORY}\``) && violation.includes('not the reviewed single entry')));

  const emptied = violationsAfter(({ config }) => {
    config.app.security.assetProtocol.scope = [];
  });
  assert.ok(emptied.some((violation) => violation.includes('exactly one entry')));
  assert.ok(emptied.some((violation) => violation.includes(`missing \`${CACHE_DESCENDANTS}\``)));

  const disabled = violationsAfter(({ config }) => {
    config.app.security.assetProtocol.enable = false;
  });
  assert.ok(disabled.some((violation) => violation.includes('must stay `true`')));

  const absent = violationsAfter(({ config }) => {
    delete config.app.security.assetProtocol;
  });
  assert.ok(absent.some((violation) => violation.includes('assetProtocol must be present')));

  const objectEntry = violationsAfter(({ config }) => {
    config.app.security.assetProtocol.scope = [{ path: CACHE_DESCENDANTS }];
  });
  assert.ok(objectEntry.some((violation) => violation.includes('must be a path string')));
  assert.ok(objectEntry.some((violation) => violation.includes(`missing \`${CACHE_DESCENDANTS}\``)));
});

test('rejects an asset protocol scope array of the wrong type', () => {
  const violations = violationsAfter(({ config }) => {
    config.app.security.assetProtocol.scope = CACHE_DESCENDANTS;
  });
  assert.ok(violations.some((violation) => violation.includes('must be an array')));
});

test('rejects a second capability file in src-tauri/capabilities', () => {
  const extra = validateTauriFsScope({
    capability: validCapability(),
    config: validConfig(),
    capabilityFiles: ['default.json', 'extra.json'],
  });
  assert.equal(extra.length, 1);
  assert.ok(extra[0].includes('`extra.json`'));
  assert.match(extra[0], /second capability file/);

  const renamed = validateTauriFsScope({
    capability: validCapability(),
    config: validConfig(),
    capabilityFiles: ['other.json'],
  });
  assert.ok(renamed.some((violation) => violation.includes('`other.json`') && violation.includes('second capability file')));
  assert.ok(renamed.some((violation) => violation.includes('`default.json` is missing')));
});

test('an unreadable or unparsable configuration fails instead of passing silently', () => {
  assert.throws(
    () => readConfiguration(join(capabilitiesDirectory, 'absent.json'), CAPABILITY_FILE),
    /src-tauri\/capabilities\/default\.json cannot be read/,
    'a missing file must throw rather than be read as empty',
  );
  assert.throws(
    () => parseConfiguration('{ "permissions": [', CAPABILITY_FILE),
    /is not valid JSON/,
    'a truncated document must throw rather than be read as empty',
  );
  assert.throws(
    () => parseConfiguration('', CONFIG_FILE),
    /is not valid JSON/,
    'an empty document must throw rather than be read as empty',
  );

  // Valid JSON that has been emptied does not throw; it reports the missing structure.
  const emptied = validateTauriFsScope({ capability: {}, config: {}, capabilityFiles: ['default.json'] });
  assert.ok(emptied.some((violation) => violation.includes('must declare a `permissions` array')));
  assert.ok(emptied.some((violation) => violation.includes('assetProtocol must be present')));
});
