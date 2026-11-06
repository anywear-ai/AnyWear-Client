// Packaged Windows desktop smoke for the image cache, capability and CSP.
//
// This script is the runtime proof the configuration guards cannot give: it builds
// nothing and installs nothing. It starts a loopback fixture server, spawns
// `tauri-driver`, launches the packaged binary built from
// `src-tauri/tauri.smoke.conf.json`, and reads `window.__smoke` from the smoke-only
// entry through WebDriver `execute/sync`.
//
// Assertions:
// - the cold mount wrote the fixture under `$APPDATA/cache/images` of the app-data
//   directory named by `com.anywear.app` (`existsAfter`, `cachePath`)
// - the remount painted from the asset protocol (`imgSrc` begins
//   `http://asset.localhost`) with a non-zero rendered width
// - no `securitypolicyviolation` was captured during the cache cycle
// - an in-page fetch to `https://example.com` is blocked by the smoke policy
//
// Evidence: `smoke-artifacts/result.json`, `smoke-artifacts/cache-listing.txt` and
// `smoke-artifacts/screenshot.png`. The script exits non-zero on any failure.
//
// Usage:
//   node scripts/packaged-smoke.mjs
//   SMOKE_BINARY=C:\path\to\anywear.exe node scripts/packaged-smoke.mjs
//
// Requires `tauri-driver` and a matching `msedgedriver.exe` on PATH (or
// `NATIVE_DRIVER` pointing at the driver). Node 24 provides `fetch`, so this script
// adds no dependency.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ARTIFACTS_DIRECTORY = join(REPOSITORY_ROOT, 'smoke-artifacts');
const FIXTURE_HOST = '127.0.0.1';
const FIXTURE_PORT = 38471;
const FIXTURE_URL = `http://${FIXTURE_HOST}:${FIXTURE_PORT}/fixture.png`;
const DRIVER_PORT = 4444;
const DRIVER_BASE_URL = `http://${FIXTURE_HOST}:${DRIVER_PORT}`;
const DRIVER_START_TIMEOUT_MS = 60_000;
const APP_START_TIMEOUT_MS = 240_000;
const SMOKE_DEADLINE_MS = 480_000;
const DEFAULT_BINARY = 'src-tauri/target/release/anywear.exe';

class SmokeError extends Error {}

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

// --- fixture image ---------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** A deterministic 64×64 orange RGB PNG; no external fixture file to lose. */
function createFixturePng(width = 64, height = 64) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour

  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 3;
      raw[pixel] = 232; // red
      raw[pixel + 1] = 122; // green
      raw[pixel + 2] = 47; // blue
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function startFixtureServer() {
  const png = createFixturePng();
  let requests = 0;
  const server = createServer((request, response) => {
    // The packaged webview origin is `http://tauri.localhost`, so the fixture is a
    // cross-origin fetch for `CachedImage`; without the CORS header the cold mount
    // would fall back to the network instead of writing the cache.
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'cache-control': 'no-store',
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    if (request.url === '/fixture.png') {
      requests += 1;
      response.writeHead(200, {
        ...headers,
        'content-type': 'image/png',
        'content-length': png.length,
      });
      response.end(png);
      return;
    }
    response.writeHead(404, { ...headers, 'content-type': 'text/plain' });
    response.end('not found');
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(FIXTURE_PORT, FIXTURE_HOST, resolvePromise);
  });
  return { server, requestCount: () => requests };
}

async function closeFixtureServer(server) {
  await new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
    setTimeout(resolvePromise, 5_000).unref();
  });
}

// --- WebDriver client ------------------------------------------------------

async function webdriverRequest(pathname, { method = 'GET', body, timeoutMs = 60_000 } = {}) {
  let response;
  try {
    response = await fetch(`${DRIVER_BASE_URL}${pathname}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new SmokeError(`WebDriver ${method} ${pathname} could not be reached: ${error.message}`);
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = text === '' ? {} : JSON.parse(text);
  } catch {
    throw new SmokeError(`WebDriver ${method} ${pathname} returned non-JSON (HTTP ${response.status}): ${text.slice(0, 500)}`);
  }
  if (!response.ok) {
    const detail = typeof parsed?.value?.message === 'string' ? parsed.value.message : text;
    throw new SmokeError(`WebDriver ${method} ${pathname} failed with HTTP ${response.status}: ${detail.slice(0, 1_000)}`);
  }
  return parsed;
}

/** `msedgedriver.exe` on PATH, or an explicit `NATIVE_DRIVER`; passed to tauri-driver when known. */
function resolveNativeDriver() {
  if (process.env.NATIVE_DRIVER) return process.env.NATIVE_DRIVER;
  const name = process.platform === 'win32' ? 'msedgedriver.exe' : 'msedgedriver';
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function spawnDriver() {
  const nativeDriver = resolveNativeDriver();
  const args = nativeDriver === undefined ? [] : ['--native-driver', nativeDriver];
  const child = spawn('tauri-driver', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = [];
  const capture = (chunk) => {
    output.push(chunk.toString());
    if (output.length > 200) output.shift();
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  const state = {
    child,
    nativeDriver,
    exited: false,
    exitCode: null,
    spawnError: null,
    log: () => output.join('').trim(),
  };
  child.on('exit', (code) => {
    state.exited = true;
    state.exitCode = code;
  });
  child.on('error', (error) => {
    state.exited = true;
    state.spawnError = error;
  });
  return state;
}

async function stopDriver(state) {
  if (state === null || state.exited) return;
  if (process.platform === 'win32') {
    // `tauri-driver` owns the msedgedriver child; kill the whole tree.
    await new Promise((resolvePromise) => {
      const killer = spawn('taskkill', ['/pid', String(state.child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('exit', resolvePromise);
      killer.on('error', resolvePromise);
    });
    return;
  }
  state.child.kill('SIGTERM');
}

async function waitForDriver(state) {
  if (state.spawnError !== null && state.spawnError !== undefined) {
    throw new SmokeError(
      `could not start tauri-driver: ${state.spawnError.message}; install it with \`cargo install tauri-driver --locked\``,
    );
  }

  const deadline = Date.now() + DRIVER_START_TIMEOUT_MS;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    if (state.exited) {
      throw new SmokeError(
        `tauri-driver exited with code ${state.exitCode} before answering /status:\n${state.log()}`,
      );
    }
    try {
      const status = await webdriverRequest('/status', { timeoutMs: 5_000 });
      if (status?.value?.ready !== false) return;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(500);
  }
  throw new SmokeError(
    `tauri-driver did not answer ${DRIVER_BASE_URL}/status within ${DRIVER_START_TIMEOUT_MS} ms: ${lastError}\n${state.log()}`,
  );
}

async function createSession(application) {
  const response = await webdriverRequest('/session', {
    method: 'POST',
    body: {
      capabilities: {
        alwaysMatch: {
          browserName: 'wry',
          'tauri:options': { application },
        },
      },
    },
    timeoutMs: APP_START_TIMEOUT_MS,
  });

  const value = response.value ?? {};
  if (typeof value.error === 'string') {
    throw new SmokeError(`session creation failed: ${value.error}: ${value.message ?? ''}`);
  }
  const sessionId = value.sessionId ?? response.sessionId;
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new SmokeError(`session creation returned no sessionId: ${JSON.stringify(response).slice(0, 1_000)}`);
  }
  return sessionId;
}

async function executeScript(sessionId, script) {
  const response = await webdriverRequest(`/session/${sessionId}/execute/sync`, {
    method: 'POST',
    body: { script, args: [] },
    timeoutMs: 30_000,
  });
  return response.value;
}

async function waitForSmokeResult(sessionId, deadline) {
  let lastValue = null;
  while (Date.now() < deadline) {
    const value = await executeScript(sessionId, 'return window.__smoke || null;');
    lastValue = value;
    if (value !== null && typeof value === 'object') {
      if (value.done === true) return value;
      if (value.done === false) throw new SmokeError(`the smoke entry reported a failure: ${value.error}`);
      if (typeof value.error === 'string') {
        throw new SmokeError(`the smoke entry script failed: ${value.error}: ${value.message ?? ''}`);
      }
    }
    await sleep(500);
  }
  throw new SmokeError(`timed out waiting for window.__smoke; last value: ${JSON.stringify(lastValue)}`);
}

async function captureScreenshot(sessionId) {
  const response = await webdriverRequest(`/session/${sessionId}/screenshot`, { timeoutMs: 30_000 });
  const base64 = response.value;
  if (typeof base64 !== 'string' || base64 === '') {
    throw new SmokeError('the WebDriver screenshot response carried no base64 image');
  }
  return Buffer.from(base64, 'base64');
}

async function deleteSession(sessionId) {
  try {
    await webdriverRequest(`/session/${sessionId}`, { method: 'DELETE', timeoutMs: 10_000 });
  } catch {
    // The session is best-effort cleanup; the driver tree is killed below anyway.
  }
}

// --- assertions and artifacts ---------------------------------------------

function assertSmoke(result) {
  const problems = [];
  if (result.existsAfter !== true) {
    problems.push('the cache file was not present after the cold mount (existsAfter is not true)');
  }
  if (typeof result.cachePath !== 'string' || !result.cachePath.toLowerCase().includes('com.anywear.app')) {
    problems.push(`the cache path does not sit under the com.anywear.app app-data directory: ${String(result.cachePath)}`);
  }
  if (typeof result.imgSrc !== 'string' || !result.imgSrc.startsWith('http://asset.localhost')) {
    problems.push(`the remount did not paint from the asset protocol (imgSrc: ${String(result.imgSrc)})`);
  }
  if (typeof result.naturalWidth !== 'number' || result.naturalWidth <= 0) {
    problems.push(`the rendered image has no natural width (naturalWidth: ${String(result.naturalWidth)})`);
  }
  if (!Array.isArray(result.violations) || result.violations.length !== 0) {
    problems.push(`the page captured CSP violations: ${JSON.stringify(result.violations)}`);
  }
  if (result.fetchBlocked !== true) {
    problems.push('an in-page fetch to https://example.com was not blocked by the smoke CSP');
  }
  if (problems.length > 0) {
    throw new SmokeError(`packaged smoke assertions failed:\n- ${problems.join('\n- ')}`);
  }
}

async function writeCacheListing(cachePath) {
  const directory = dirname(cachePath);
  const lines = [`cache directory: ${directory}`];
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const information = await stat(join(directory, entry.name));
      lines.push(`${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name} ${information.size} bytes`);
    }
  } catch (error) {
    lines.push(`cache directory could not be listed: ${error.message}`);
  }
  await writeFile(join(ARTIFACTS_DIRECTORY, 'cache-listing.txt'), `${lines.join('\n')}\n`, 'utf8');
}

async function writeResult(result) {
  await writeFile(join(ARTIFACTS_DIRECTORY, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

// --- main ------------------------------------------------------------------

const startedAt = Date.now();
const binary = resolve(REPOSITORY_ROOT, process.env.SMOKE_BINARY ?? DEFAULT_BINARY);
const result = {
  schema_version: 1,
  status: 'failed',
  binary,
  fixture: { url: FIXTURE_URL, requests: 0 },
  driver: { command: 'tauri-driver', native_driver: null },
};
let driverState = null;
let sessionId = null;
let fixture = null;
let screenshot = null;

try {
  await mkdir(ARTIFACTS_DIRECTORY, { recursive: true });

  if (!existsSync(binary)) {
    throw new SmokeError(
      `the packaged binary was not found at ${binary}; build it with \`pnpm exec tauri build --no-bundle --config src-tauri/tauri.smoke.conf.json\` or set SMOKE_BINARY`,
    );
  }

  fixture = await startFixtureServer();
  driverState = spawnDriver();
  result.driver.native_driver = driverState.nativeDriver ?? 'resolved by tauri-driver from PATH';
  await waitForDriver(driverState);

  sessionId = await createSession(binary);
  const smoke = await waitForSmokeResult(sessionId, startedAt + SMOKE_DEADLINE_MS);
  Object.assign(result, {
    cachePath: smoke.cachePath,
    existsAfter: smoke.existsAfter,
    imgSrc: smoke.imgSrc,
    naturalWidth: smoke.naturalWidth,
    violations: smoke.violations,
    fetchBlocked: smoke.fetchBlocked,
  });
  result.fixture.requests = fixture.requestCount();
  result.duration_ms = Date.now() - startedAt;
  screenshot = await captureScreenshot(sessionId);
  assertSmoke(smoke);

  result.status = 'passed';
  result.duration_ms = Date.now() - startedAt;

  await writeCacheListing(smoke.cachePath);
  await writeFile(join(ARTIFACTS_DIRECTORY, 'screenshot.png'), screenshot);
  await writeResult(result);

  console.log(`packaged smoke passed in ${result.duration_ms} ms`);
  console.log(`  binary: ${binary}`);
  console.log(`  cache:  ${smoke.cachePath} (existsAfter=${smoke.existsAfter})`);
  console.log(`  imgSrc: ${smoke.imgSrc} (naturalWidth=${smoke.naturalWidth})`);
  console.log(`  CSP violations: ${smoke.violations.length}; fixture requests: ${result.fixture.requests}`);
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  result.duration_ms = Date.now() - startedAt;
  if (fixture !== null) result.fixture.requests = fixture.requestCount();

  try {
    if (result.cachePath !== undefined) {
      await writeCacheListing(result.cachePath);
    }
    if (screenshot !== null) {
      await writeFile(join(ARTIFACTS_DIRECTORY, 'screenshot.png'), screenshot);
    }
    await writeResult(result);
  } catch (artifactError) {
    console.error(`could not write failure artifacts: ${artifactError.message}`);
  }

  if (driverState !== null && driverState.log() !== '') {
    console.error(`tauri-driver output:\n${driverState.log()}`);
  }
  console.error(`packaged smoke failed: ${result.error}`);
  process.exitCode = 1;
} finally {
  if (sessionId !== null) await deleteSession(sessionId);
  if (driverState !== null) await stopDriver(driverState);
  if (fixture !== null) await closeFixtureServer(fixture.server);
}
