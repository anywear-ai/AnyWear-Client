// Tauri filesystem-scope guard for the image cache ADR 0003 owns.
//
// `src-tauri/capabilities/default.json` names the filesystem commands the webview
// may call and the global `fs:scope` patterns those commands match;
// `src-tauri/tauri.conf.json` names the same directory for the asset protocol that
// serves a cached file back to the webview. Both files currently grant the whole
// `$APPDATA` tree, and nothing in the repository fails if a later edit widens them
// again. This guard is the second control: `validateTauriFsScope` reports every way
// the two parsed documents grant or lose a path outside `$APPDATA/cache/images`,
// and the first positive case below runs it against the checked-in files.
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

export const CACHE_DIRECTORY = '$APPDATA/cache/images';
export const CACHE_DESCENDANTS = `${CACHE_DIRECTORY}/**`;
export const CANONICAL_SCOPE = [CACHE_DIRECTORY, CACHE_DESCENDANTS];
export const COMMAND_PERMISSIONS = ['fs:allow-exists', 'fs:allow-mkdir', 'fs:allow-write-file'];
export const CAPABILITY_FILE = 'src-tauri/capabilities/default.json';
export const CONFIG_FILE = 'src-tauri/tauri.conf.json';
export const CAPABILITIES_DIRECTORY = 'src-tauri/capabilities';

// Why each command permission is load-bearing, so a missing one fails with the
// consequence rather than only the name. `fs:allow-write-file` also enables `open`
// and `write`, which the plugin's JavaScript `writeFile` path calls.
const COMMAND_PURPOSE = {
  'fs:allow-exists': 'without it `exists()` rejects at the IPC layer and the cache silently stops being read',
  'fs:allow-mkdir': 'without it `mkdir()` rejects and the cache directory is never created',
  'fs:allow-write-file': 'without it `writeFile()` rejects at the IPC layer and the cache silently stops being written',
};

// What each canonical pattern matches, so a missing entry names the caller it serves.
const CANONICAL_MEANING = {
  [CACHE_DIRECTORY]: 'the cache directory itself, which `exists` and `mkdir` name',
  [CACHE_DESCENDANTS]: 'the files inside the cache directory',
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

  return { pattern: pattern.replace(/\/{2,}/g, '/').replace(/\/+$/, '') };
}

/**
 * Reports every way a list of unresolved patterns departs from exactly the two
 * canonical image-cache entries: a pattern outside the cache directory, a repeated
 * canonical entry, or a missing one.
 */
function validateCanonicalPatterns({ patterns, label, file }) {
  const violations = [];
  const remaining = [...patterns];
  for (const canonical of CANONICAL_SCOPE) {
    const at = remaining.indexOf(canonical);
    if (at < 0) {
      violations.push(`${file}: ${label} is missing \`${canonical}\` (${CANONICAL_MEANING[canonical]}); the pair is Tauri's own recursive base-directory scope shape`);
    } else {
      remaining.splice(at, 1);
    }
  }
  for (const pattern of remaining) {
    if (CANONICAL_SCOPE.includes(pattern)) {
      violations.push(`${file}: ${label} repeats \`${pattern}\`; the allow list must be exactly the two image-cache entries`);
    } else {
      violations.push(`${file}: ${label} entry \`${pattern}\` is outside the image cache directory; the only allowed entries are \`${CACHE_DIRECTORY}\` and \`${CACHE_DESCENDANTS}\``);
    }
  }
  return violations;
}

/**
 * Every way the two parsed documents depart from the ADR 0003 boundary: the
 * capability may enable only `fs:allow-exists`, `fs:allow-mkdir` and
 * `fs:allow-write-file` plus one `fs:scope` whose allow list is exactly the two
 * image-cache entries; the asset protocol must stay enabled with the same pair; and
 * `src-tauri/capabilities/` may hold only `default.json`, because Tauri enables
 * every capability file in that directory.
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

  const permissions = capability?.permissions;
  if (!Array.isArray(permissions)) {
    violations.push(`${CAPABILITY_FILE}: the capability must declare a \`permissions\` array`);
  } else {
    const commands = [];
    const scopes = [];
    permissions.forEach((entry, index) => {
      if (typeof entry === 'string') {
        if (entry.startsWith('fs:')) commands.push({ identifier: entry, index });
        return;
      }
      if (!isPlainObject(entry) || typeof entry.identifier !== 'string') {
        violations.push(`${CAPABILITY_FILE}: permissions[${index}] is neither a permission identifier nor an object carrying one`);
        return;
      }
      if (!entry.identifier.startsWith('fs:')) return;
      if (entry.identifier === 'fs:scope') {
        scopes.push({ entry, index });
        return;
      }
      violations.push(`${CAPABILITY_FILE}: permissions[${index}] declares \`${entry.identifier}\` as an object; the only fs permission that may carry a scope is \`fs:scope\``);
    });

    for (const { identifier, index } of commands) {
      if (!COMMAND_PERMISSIONS.includes(identifier)) {
        violations.push(`${CAPABILITY_FILE}: permissions[${index}] declares \`${identifier}\`, which is outside the filesystem command allowlist (\`${COMMAND_PERMISSIONS.join('`, `')}\`)`);
      }
    }
    for (const permission of COMMAND_PERMISSIONS) {
      if (!commands.some((command) => command.identifier === permission)) {
        violations.push(`${CAPABILITY_FILE}: the capability must name \`${permission}\`; ${COMMAND_PURPOSE[permission]}`);
      }
    }

    if (scopes.length === 0) {
      violations.push(`${CAPABILITY_FILE}: the capability must declare exactly one \`fs:scope\` permission with the two image-cache entries`);
    }
    for (const extra of scopes.slice(1)) {
      violations.push(`${CAPABILITY_FILE}: permissions[${extra.index}] declares a second \`fs:scope\`; Tauri unions every declared scope, so a second object could grant a path the first one never shows`);
    }

    const scope = scopes[0]?.entry;
    if (scope) {
      for (const key of Object.keys(scope)) {
        if (!['identifier', 'allow', 'deny'].includes(key)) {
          violations.push(`${CAPABILITY_FILE}: the \`fs:scope\` permission carries \`${key}\`, which is not one of \`identifier\`, \`allow\` or \`deny\``);
        }
      }

      if (scope.allow === undefined) {
        violations.push(`${CAPABILITY_FILE}: fs:scope must declare an \`allow\` list with the two image-cache entries`);
      } else if (!Array.isArray(scope.allow)) {
        violations.push(`${CAPABILITY_FILE}: fs:scope \`allow\` must be an array`);
      } else {
        const patterns = [];
        scope.allow.forEach((entry, index) => {
          const read = readScopeEntry(entry, CAPABILITY_FILE, 'fs:scope allow', index);
          if (read.violation) violations.push(read.violation);
          else patterns.push(read.pattern);
        });
        violations.push(...validateCanonicalPatterns({ patterns, label: 'fs:scope allow', file: CAPABILITY_FILE }));
      }

      if (scope.deny !== undefined) {
        if (!Array.isArray(scope.deny)) {
          violations.push(`${CAPABILITY_FILE}: fs:scope \`deny\` must be an array`);
        } else {
          scope.deny.forEach((entry, index) => {
            const read = readScopeEntry(entry, CAPABILITY_FILE, 'fs:scope deny', index);
            if (read.violation) {
              violations.push(read.violation);
              return;
            }
            if (read.pattern !== CACHE_DIRECTORY && !read.pattern.startsWith(`${CACHE_DIRECTORY}/`)) {
              violations.push(`${CAPABILITY_FILE}: fs:scope deny entry \`${read.pattern}\` is outside the image cache directory; a deny entry may only narrow within \`${CACHE_DIRECTORY}\``);
            }
          });
        }
      }
    }
  }

  const assetProtocol = config?.app?.security?.assetProtocol;
  if (!isPlainObject(assetProtocol)) {
    violations.push(`${CONFIG_FILE}: app.security.assetProtocol must be present; it is the only gate that decides which local files \`convertFileSrc\` may serve`);
  } else {
    if (assetProtocol.enable !== true) {
      violations.push(`${CONFIG_FILE}: app.security.assetProtocol.enable must stay \`true\`, found ${describe(assetProtocol.enable)}`);
    }
    if (!Array.isArray(assetProtocol.scope)) {
      violations.push(`${CONFIG_FILE}: app.security.assetProtocol.scope must be an array with the two image-cache entries`);
    } else {
      const patterns = [];
      assetProtocol.scope.forEach((entry, index) => {
        if (typeof entry !== 'string') {
          violations.push(`${CONFIG_FILE}: app.security.assetProtocol.scope[${index}] entry ${describe(entry)} must be a path string`);
        } else if (entry.includes('\\')) {
          violations.push(`${CONFIG_FILE}: app.security.assetProtocol.scope[${index}] entry \`${entry}\` uses a backslash as a path separator; macOS and Linux read it as a literal filename character, so the entry must be spelled with \`/\``);
        } else {
          patterns.push(entry.replace(/\/{2,}/g, '/').replace(/\/+$/, ''));
        }
      });
      violations.push(...validateCanonicalPatterns({ patterns, label: 'app.security.assetProtocol.scope', file: CONFIG_FILE }));
    }
  }

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
      'opener:default',
      'fs:allow-exists',
      'fs:allow-mkdir',
      'fs:allow-write-file',
      'log:default',
      {
        identifier: 'fs:scope',
        allow: [
          { path: CACHE_DIRECTORY },
          { path: CACHE_DESCENDANTS },
        ],
      },
    ],
  };
}

/** A `tauri.conf.json` in the delivered shape, for the negative cases below. */
function validConfig() {
  return {
    $schema: 'https://schema.tauri.app/config/2',
    productName: 'tauri-app',
    version: '0.1.0',
    identifier: 'com.anywear.app',
    app: {
      windows: [{ title: 'tauri-app', width: 800, height: 600 }],
      security: {
        csp: null,
        assetProtocol: {
          enable: true,
          scope: [CACHE_DIRECTORY, CACHE_DESCENDANTS],
        },
      },
    },
  };
}

/** The one `fs:scope` permission of a capability the negative cases mutate. */
function scopePermissionOf(capability) {
  return capability.permissions.find((entry) => isPlainObject(entry) && entry.identifier === 'fs:scope');
}

/** Runs the validator on a fresh valid pair after `mutate` edits it. */
function violationsAfter(mutate) {
  const capability = structuredClone(validCapability());
  const config = structuredClone(validConfig());
  mutate?.({ capability, config });
  return validateTauriFsScope({ capability, config, capabilityFiles: ['default.json'] });
}

test('the checked-in capability and asset protocol scope grant only the image cache', () => {
  assert.deepEqual(validateTauriFsScope(checkedInConfiguration()), []);
});

test('a synthetic canonical pair is accepted, including repeated and trailing separators', () => {
  assert.deepEqual(violationsAfter(), []);

  const capability = structuredClone(validCapability());
  scopePermissionOf(capability).allow = [{ path: '$APPDATA/cache//images/' }, { path: CACHE_DESCENDANTS }];
  assert.deepEqual(validateTauriFsScope({ capability, config: validConfig(), capabilityFiles: ['default.json'] }), []);
});

test('rejects every allow entry outside the image cache directory and names it', () => {
  for (const path of ['$APPDATA/**', '$APPDATA', '$APPDATA/*', '$APPDATA/cache', '$APPDATA/cache/**']) {
    const violations = violationsAfter(({ capability }) => {
      scopePermissionOf(capability).allow.push({ path });
    });
    assert.equal(violations.length, 1, `\`${path}\` must be the only violation`);
    assert.ok(violations[0].includes(`\`${path}\``), `the violation must name \`${path}\`: ${violations[0]}`);
    assert.match(violations[0], /outside the image cache directory/);
  }

  // A wider entry that replaces both canonical ones is reported as the widening and
  // as the two entries it displaced; neither reading lets it pass.
  const violations = violationsAfter(({ capability }) => {
    scopePermissionOf(capability).allow = [{ path: '$APPDATA/**' }];
  });
  assert.ok(violations.some((violation) => violation.includes('`$APPDATA/**`') && violation.includes('outside the image cache directory')));
  assert.ok(violations.some((violation) => violation.includes(`missing \`${CACHE_DIRECTORY}\``)));
  assert.ok(violations.some((violation) => violation.includes(`missing \`${CACHE_DESCENDANTS}\``)));
});

test('rejects a Windows separator instead of normalizing it', () => {
  const violations = violationsAfter(({ capability, config }) => {
    scopePermissionOf(capability).allow = [{ path: '$APPDATA\\cache\\images' }, { path: '$APPDATA\\cache\\images\\**' }];
    config.app.security.assetProtocol.scope = ['$APPDATA\\cache\\images', '$APPDATA\\cache\\images\\**'];
  });
  assert.ok(violations.some((violation) => violation.includes('$APPDATA\\cache\\images') && violation.includes('backslash')));
  assert.ok(violations.some((violation) => violation.includes('$APPDATA\\cache\\images\\**') && violation.includes('backslash')));
  // The spelling is rejected, not read as the canonical entry.
  assert.ok(violations.some((violation) => violation.includes(`missing \`${CACHE_DIRECTORY}\``)));
});

test('rejects a base-directory variable other than $APPDATA', () => {
  const violations = violationsAfter(({ capability, config }) => {
    scopePermissionOf(capability).allow = [{ path: '$APPLOCALDATA/cache/images' }, { path: '$APPLOCALDATA/cache/images/**' }];
    config.app.security.assetProtocol.scope = ['$APPLOCALDATA/cache/images', '$APPLOCALDATA/cache/images/**'];
  });
  for (const file of [CAPABILITY_FILE, CONFIG_FILE]) {
    assert.ok(
      violations.some((violation) => violation.startsWith(file) && violation.includes('$APPLOCALDATA/cache/images') && violation.includes('outside the image cache directory')),
      `\`$APPLOCALDATA\` entries in ${file} must be rejected`,
    );
  }
});

test('rejects every fs command permission outside the three the cache calls', () => {
  for (const identifier of ['fs:allow-appdata-read', 'fs:allow-appdata-write', 'fs:allow-read', 'fs:allow-write', 'fs:allow-copy-file']) {
    const violations = violationsAfter(({ capability }) => {
      capability.permissions.push(identifier);
    });
    assert.equal(violations.length, 1, `\`${identifier}\` must be the only violation`);
    assert.ok(violations[0].includes(`\`${identifier}\``), `the violation must name \`${identifier}\``);
    assert.match(violations[0], /outside the filesystem command allowlist/);
  }

  // An object form that carries its own scope is not one of the three bare
  // permission identifiers, so it is rejected rather than read as the command.
  const violations = violationsAfter(({ capability }) => {
    capability.permissions = capability.permissions.filter((entry) => entry !== 'fs:allow-exists');
    capability.permissions.push({ identifier: 'fs:allow-exists', allow: [{ path: '$APPDATA/**' }] });
  });
  assert.ok(violations.some((violation) => violation.includes('`fs:allow-exists`') && violation.includes('only fs permission that may carry a scope')));
});

test('rejects dropping fs:allow-exists, fs:allow-mkdir or fs:allow-write-file', () => {
  for (const identifier of COMMAND_PERMISSIONS) {
    const violations = violationsAfter(({ capability }) => {
      capability.permissions = capability.permissions.filter((entry) => entry !== identifier);
    });
    assert.equal(violations.length, 1, `dropping \`${identifier}\` must be the only violation`);
    assert.ok(violations[0].includes(`\`${identifier}\``), `the violation must name \`${identifier}\``);
    assert.match(violations[0], /the capability must name/);
  }
});

test('rejects a second fs:scope permission and any entry shape that hides a path', () => {
  const duplicated = violationsAfter(({ capability }) => {
    capability.permissions.push({ identifier: 'fs:scope', allow: [{ path: CACHE_DIRECTORY }, { path: CACHE_DESCENDANTS }] });
  });
  assert.equal(duplicated.length, 1);
  assert.match(duplicated[0], /second `fs:scope`/);

  // The bare-string form is Tauri's other accepted `FsScopeEntry` spelling.
  const bare = structuredClone(validCapability());
  scopePermissionOf(bare).allow = [CACHE_DIRECTORY, CACHE_DESCENDANTS];
  assert.deepEqual(validateTauriFsScope({ capability: bare, config: validConfig(), capabilityFiles: ['default.json'] }), []);

  const extraKey = violationsAfter(({ capability }) => {
    scopePermissionOf(capability).allow = [{ path: CACHE_DIRECTORY, recursive: true }, { path: CACHE_DESCENDANTS }];
  });
  assert.ok(extraKey.some((violation) => violation.includes('carrying no other key')));

  const wrongType = violationsAfter(({ capability }) => {
    scopePermissionOf(capability).allow = [42, { path: CACHE_DESCENDANTS }];
  });
  assert.ok(wrongType.some((violation) => violation.includes('must be a path string or a `{ "path": ... }` object')));

  const unknownKey = violationsAfter(({ capability }) => {
    scopePermissionOf(capability).glob = '**';
  });
  assert.ok(unknownKey.some((violation) => violation.includes('carries `glob`')));
});

test('rejects an over-narrowed or emptied allow list', () => {
  for (const removed of CANONICAL_SCOPE) {
    const violations = violationsAfter(({ capability }) => {
      scopePermissionOf(capability).allow = scopePermissionOf(capability).allow.filter((entry) => entry.path !== removed);
    });
    assert.equal(violations.length, 1, `removing \`${removed}\` must be the only violation`);
    assert.ok(violations[0].includes(`missing \`${removed}\``), `the violation must name \`${removed}\``);
  }

  const emptied = violationsAfter(({ capability }) => {
    scopePermissionOf(capability).allow = [];
  });
  assert.equal(emptied.length, 2);
  assert.ok(emptied.some((violation) => violation.includes(`missing \`${CACHE_DIRECTORY}\``)));
  assert.ok(emptied.some((violation) => violation.includes(`missing \`${CACHE_DESCENDANTS}\``)));

  const withoutScope = violationsAfter(({ capability }) => {
    capability.permissions = capability.permissions.filter((entry) => !isPlainObject(entry) || entry.identifier !== 'fs:scope');
  });
  assert.equal(withoutScope.length, 1);
  assert.match(withoutScope[0], /must declare exactly one `fs:scope`/);
});

test('rejects a deny entry that names a path outside the cache directory', () => {
  for (const path of ['$APPDATA', '$APPDATA/**', '$APPDATA/cache']) {
    const violations = violationsAfter(({ capability }) => {
      scopePermissionOf(capability).deny = [{ path }];
    });
    assert.equal(violations.length, 1, `deny \`${path}\` must be the only violation`);
    assert.ok(violations[0].includes(`\`${path}\``));
    assert.match(violations[0], /deny entry .* outside the image cache directory/);
  }

  // A deny entry inside the cache directory only narrows, so it stays accepted.
  const inside = violationsAfter(({ capability }) => {
    scopePermissionOf(capability).deny = [{ path: `${CACHE_DIRECTORY}/private/**` }];
  });
  assert.deepEqual(inside, []);
});

test('rejects any asset protocol scope that is not exactly the image-cache pair', () => {
  for (const path of ['$APPDATA/**', '$APPDATA', '$APPDATA/*', '$APPDATA/cache', '$APPDATA/cache/**']) {
    const violations = violationsAfter(({ config }) => {
      config.app.security.assetProtocol.scope = [path];
    });
    assert.ok(violations.some((violation) => violation.includes(`\`${path}\``) && violation.includes('outside the image cache directory')), `\`${path}\` must be rejected`);
  }

  const narrowed = violationsAfter(({ config }) => {
    config.app.security.assetProtocol.scope = [CACHE_DESCENDANTS];
  });
  assert.equal(narrowed.length, 1);
  assert.ok(narrowed[0].includes(`missing \`${CACHE_DIRECTORY}\``));

  const emptied = violationsAfter(({ config }) => {
    config.app.security.assetProtocol.scope = [];
  });
  assert.equal(emptied.length, 2);

  const disabled = violationsAfter(({ config }) => {
    config.app.security.assetProtocol.enable = false;
  });
  assert.equal(disabled.length, 1);
  assert.match(disabled[0], /assetProtocol\.enable must stay `true`/);

  const absent = violationsAfter(({ config }) => {
    delete config.app.security.assetProtocol;
  });
  assert.equal(absent.length, 1);
  assert.match(absent[0], /assetProtocol must be present/);

  const objectEntry = violationsAfter(({ config }) => {
    config.app.security.assetProtocol.scope = [{ path: CACHE_DIRECTORY }, { path: CACHE_DESCENDANTS }];
  });
  assert.equal(objectEntry.filter((violation) => violation.includes('must be a path string')).length, 2);
  assert.ok(objectEntry.some((violation) => violation.includes(`missing \`${CACHE_DIRECTORY}\``)));
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
