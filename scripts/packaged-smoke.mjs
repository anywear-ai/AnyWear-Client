// Packaged Windows desktop smoke for the image cache, capability and CSP.
//
// This script is the runtime proof the configuration guards cannot give: it builds
// nothing and installs nothing. It starts a loopback fixture server, spawns
// `tauri-driver`, launches the packaged binary built from
// `src-tauri/tauri.smoke.conf.json`, and reads `window.__smoke` from the smoke-only
// entry through WebDriver `execute/sync`.
//
// Hosted Windows runners are elevated, and an elevated WebView2 host ignores the
// browser arguments EdgeDriver uses for its remote-debugging attach, so the
// WebDriver session cannot be created there (`DevToolsActivePort file doesn't
// exist`). The smoke therefore has two evidence channels over the same packaged
// binary, the same `$APPDATA/cache/images/**` capability and the same CSP:
//
// 1. WebDriver: `window.__smoke`, the first attempt on a non-elevated runner.
// 2. App-written file: `$APPDATA/cache/images/smoke-result.json`, written by the
//    smoke entry through `fs:allow-write-file` and read here. Used only when the
//    WebDriver attach fails with the elevation/DevToolsActivePort failure (or when
//    `SMOKE_CHANNEL=file` is set), and recorded in `result.json` as
//    `evidence.channel: "file"` with `evidence.webdriver_error` naming the attach
//    failure. The fallback is announced on the console; it is never silent.
//
// Assertions (both channels):
// - the cold mount wrote the fixture under `$APPDATA/cache/images` of the app-data
//   directory named by `com.anywear.app` (`existsAfter`, `cachePath`)
// - the remount painted from the asset protocol (`imgSrc` begins
//   `http://asset.localhost`) with a non-zero rendered width
// - no `securitypolicyviolation` was captured during the cache cycle
// - an in-page fetch to `https://example.com` is blocked by the smoke policy
// - after that phase the entry mounted the real `src/App.tsx` tree at `/wardrobe`,
//   clicked the top link bar's Dashboard link once, and: the Wardrobe page was
//   rendered and the link visible before the click; the link was the top bar's;
//   the location became `/dashboard` with the boot counter still 1 (no document
//   reload); the dashboard rendered `Hangzhou, Zhejiang`, `22°C`, `Sunny`, the
//   `Today` heading and the `Explore your wardrobe` link; the navigation stayed
//   visible before and after; `Setting up your wardrobe...` never appeared; and no
//   `securitypolicyviolation` was recorded during the navigation phase.
//
// Evidence: `smoke-artifacts/result.json`, `smoke-artifacts/cache-listing.txt` and,
// when WebDriver produced one, `smoke-artifacts/screenshot.png`. The script exits
// non-zero on any assertion failure or when the file never appears.
//
// Usage:
//   node scripts/packaged-smoke.mjs
//   SMOKE_BINARY=C:\path\to\anywear.exe node scripts/packaged-smoke.mjs
//   SMOKE_CHANNEL=file node scripts/packaged-smoke.mjs
//   SMOKE_RESULT_PATH=C:\path\to\smoke-result.json node scripts/packaged-smoke.mjs
//
// Requires `tauri-driver` and a matching `msedgedriver.exe` on PATH (or
// `NATIVE_DRIVER` pointing at the driver) for the WebDriver channel. Node 24
// provides `fetch`, so this script adds no dependency.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
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
// The entry's watchdog is 150 s: the image phase plus the app mount and the
// click. This channel is 240 s so the watchdog always fires first and its
// failure is reported instead of replaced by this read's own timeout.
const FILE_CHANNEL_TIMEOUT_MS = 240_000;
const DEFAULT_BINARY = 'src-tauri/target/release/anywear.exe';
const RESULT_FILE_NAME = 'smoke-result.json';
const SMOKE_CHANNEL = (process.env.SMOKE_CHANNEL ?? '').toLowerCase();

// The profile the app reads at startup. It carries a location and a balance so
// the dashboard and the Mirror shell have data; nothing here is a real identity.
const FIXTURE_USER = {
  id: 'test-user-id',
  email: 'test@anywear.local',
  displayName: null,
  latitude: null,
  longitude: null,
  locationId: '101210101',
  locationName: 'Hangzhou, Zhejiang',
  dailyRecommendationTime: null,
  dailyCredits: 10,
  lastCreditRecharge: null,
  createdAt: '2026-11-10T10:00:00Z',
};

// The exact values the browser spec uses, so both checks assert the same page.
const FIXTURE_WEATHER = {
  locationName: 'Hangzhou, Zhejiang',
  temperature: '22',
  feelsLike: '24',
  icon: '100',
  conditionText: 'Sunny',
  humidity: '45',
  windDir: 'North',
  windScale: '1',
  obsTime: '2026-11-10T10:00:00Z',
  stale: false,
  clothingIndex: { suggestion: 'Light clothing is enough.' },
};

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
    // cross-origin request for `CachedImage` and for the app's Axios reads; without
    // the CORS headers the cold mount would fall back to the network and every API
    // read would fail. `access-control-allow-headers: *` admits the app's
    // `Authorization` and `X-AnyWear-Client-Version` request headers, and every
    // path answers the preflight.
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': '*',
      'cache-control': 'no-store',
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    const pathname = new URL(request.url ?? '/', `http://${FIXTURE_HOST}`).pathname;
    if (pathname === '/fixture.png') {
      requests += 1;
      response.writeHead(200, {
        ...headers,
        'content-type': 'image/png',
        'content-length': png.length,
      });
      response.end(png);
      return;
    }
    const jsonResponses = {
      '/users/me': FIXTURE_USER,
      '/wardrobe': [],
      '/wardrobe/categories': { categories: [] },
      '/outfits': { outfits: [] },
      '/weather/current': FIXTURE_WEATHER,
    };
    if (pathname in jsonResponses) {
      response.writeHead(200, { ...headers, 'content-type': 'application/json' });
      response.end(JSON.stringify(jsonResponses[pathname]));
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

/** The elevated-host attach failure this smoke falls back from; no other error does. */
function isElevationAttachFailure(error) {
  return /DevToolsActivePort/i.test(error instanceof Error ? error.message : String(error));
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

/** Force-kills a process and its descendants; best effort on every platform. */
async function killProcessTree(pid) {
  if (pid === undefined || pid === null) return;
  if (process.platform === 'win32') {
    await new Promise((resolvePromise) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('exit', resolvePromise);
      killer.on('error', resolvePromise);
    });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

/** Kills any packaged app process, including one a failed WebDriver attempt left. */
async function killAppProcesses(application) {
  if (process.platform !== 'win32') return;
  await new Promise((resolvePromise) => {
    const killer = spawn('taskkill', ['/IM', basename(application), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('exit', resolvePromise);
    killer.on('error', resolvePromise);
  });
}

async function stopDriver(state) {
  if (state === null || state.exited) return;
  await killProcessTree(state.child.pid);
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

// --- app-written file channel ---------------------------------------------

async function removeStaleResult(path) {
  if (path === null) return;
  try {
    await rm(path, { force: true });
  } catch {
    // A path that cannot be removed is reported when the file is read.
  }
}

/**
 * Launches the packaged binary directly and waits for the smoke entry to write its
 * result through `fs:allow-write-file`. Used only for the elevated-host fallback,
 * and the assertions are the same ones the WebDriver channel applies.
 */
async function waitForAppResultFile(application, path, deadline) {
  await killAppProcesses(application);
  // Give the killed WebDriver-launched process a moment to release the WebView2
  // user-data directory before the direct launch opens it.
  await sleep(1_000);
  await removeStaleResult(path);

  const app = spawn(application, [], { stdio: 'ignore', windowsHide: true });
  try {
    let lastError = 'the result file never appeared';
    while (Date.now() < deadline) {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        if (parsed !== null && typeof parsed === 'object') {
          if (parsed.done === false) {
            throw new SmokeError(`the app-written result reported a failure: ${parsed.error}`);
          }
          if (parsed.done === true) return parsed;
        }
        lastError = `the result file carried no usable result: ${JSON.stringify(parsed).slice(0, 500)}`;
      } catch (error) {
        if (error instanceof SmokeError) throw error;
        lastError = error.message;
      }
      await sleep(500);
    }
    throw new SmokeError(
      `the app did not write the smoke result file within ${FILE_CHANNEL_TIMEOUT_MS / 1000} s: ${path} (${lastError})`,
    );
  } finally {
    await killProcessTree(app.pid);
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
  if (result.wardrobeRenderedBeforeClick !== true) {
    problems.push('the Wardrobe page had not rendered before the Dashboard click (wardrobeRenderedBeforeClick)');
  }
  if (result.dashboardLinkVisibleBeforeClick !== true) {
    problems.push('the top bar\'s Dashboard link was not visible before the click (dashboardLinkVisibleBeforeClick)');
  }
  if (result.dashboardLinkWasTopBar !== true) {
    problems.push('the clicked Dashboard link was not in the top link bar (dashboardLinkWasTopBar)');
  }
  if (result.dashboardLinkClicked !== true) {
    problems.push('the top bar\'s Dashboard link was never clicked (dashboardLinkClicked)');
  }
  if (result.locationAfterClick !== '/dashboard') {
    problems.push(`the location after the click was not /dashboard: ${String(result.locationAfterClick)}`);
  }
  if (result.boots !== 1 || result.documentReloaded !== false) {
    problems.push(`the document reloaded during the navigation (boots: ${String(result.boots)}, documentReloaded: ${String(result.documentReloaded)})`);
  }
  if (result.weatherLocationText !== 'Hangzhou, Zhejiang') {
    problems.push(`the weather location did not render: ${String(result.weatherLocationText)}`);
  }
  if (result.weatherTemperatureText !== '22°C') {
    problems.push(`the weather temperature did not render: ${String(result.weatherTemperatureText)}`);
  }
  if (result.weatherConditionText !== 'Sunny') {
    problems.push(`the weather condition did not render: ${String(result.weatherConditionText)}`);
  }
  if (result.todayHeadingVisible !== true) {
    problems.push('the Today heading did not render on the dashboard');
  }
  if (result.exploreWardrobeLinkVisible !== true) {
    problems.push('the Explore your wardrobe link did not render on the dashboard');
  }
  if (result.navigationVisibleBeforeClick !== true) {
    problems.push('the navigation was not visible before the Dashboard click');
  }
  if (result.navigationVisibleAfterClick !== true) {
    problems.push('the navigation was not visible after the Dashboard click');
  }
  if (result.dashboardLinkVisibleAfterClick !== true) {
    problems.push('the top bar Dashboard link was not visible after the click (dashboardLinkVisibleAfterClick)');
  }
  if (result.dashboardLinkDisplay !== 'inline-flex') {
    problems.push(`the top bar Dashboard link did not carry its Tailwind display utility (display: ${String(result.dashboardLinkDisplay)})`);
  }
  if (result.settingUpWardrobeAfterClick !== false) {
    problems.push('`Setting up your wardrobe...` appeared after the Dashboard click');
  }
  if (!Array.isArray(result.navigationViolations) || result.navigationViolations.length !== 0) {
    problems.push(`the page captured CSP violations during the navigation: ${JSON.stringify(result.navigationViolations)}`);
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
const resultPath = process.env.SMOKE_RESULT_PATH
  ?? (process.env.APPDATA === undefined
    ? null
    : join(process.env.APPDATA, 'com.anywear.app', 'cache', 'images', RESULT_FILE_NAME));
const result = {
  schema_version: 1,
  status: 'failed',
  binary,
  fixture: { url: FIXTURE_URL, requests: 0 },
  driver: { command: 'tauri-driver', native_driver: null },
  evidence: { channel: null },
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
  await removeStaleResult(resultPath);

  let smoke = null;
  let channel = null;
  let webdriverError = null;

  if (SMOKE_CHANNEL === 'file') {
    webdriverError = 'skipped by SMOKE_CHANNEL=file';
    console.warn('[packaged-smoke] SMOKE_CHANNEL=file: skipping the WebDriver attempt; using the app-written result file.');
  } else {
    driverState = spawnDriver();
    result.driver.native_driver = driverState.nativeDriver ?? 'resolved by tauri-driver from PATH';
    await waitForDriver(driverState);
    try {
      sessionId = await createSession(binary);
    } catch (error) {
      if (!isElevationAttachFailure(error)) throw error;
      webdriverError = error instanceof Error ? error.message : String(error);
      console.warn(`[packaged-smoke] WebDriver attach failed: ${webdriverError}`);
      console.warn(
        '[packaged-smoke] This hosted runner is elevated, so WebView2 refuses the EdgeDriver remote-debugging attach. '
          + 'Falling back to the app-written result file; the same packaged binary, CSP and capability are exercised.',
      );
      await stopDriver(driverState);
      driverState = null;
      await killAppProcesses(binary);
    }
  }

  if (sessionId !== null) {
    smoke = await waitForSmokeResult(sessionId, startedAt + SMOKE_DEADLINE_MS);
    channel = 'webdriver';
  } else {
    if (resultPath === null) {
      throw new SmokeError('cannot derive the app-written result path: APPDATA is not set and SMOKE_RESULT_PATH is empty');
    }
    channel = 'file';
    smoke = await waitForAppResultFile(binary, resultPath, Date.now() + FILE_CHANNEL_TIMEOUT_MS);
  }

  result.evidence.channel = channel;
  if (channel === 'file') result.evidence.result_path = resultPath;
  if (webdriverError !== null) result.evidence.webdriver_error = webdriverError;
  Object.assign(result, {
    cachePath: smoke.cachePath,
    existsAfter: smoke.existsAfter,
    imgSrc: smoke.imgSrc,
    naturalWidth: smoke.naturalWidth,
    violations: smoke.violations,
    fetchBlocked: smoke.fetchBlocked,
    boots: smoke.boots,
    wardrobeRenderedBeforeClick: smoke.wardrobeRenderedBeforeClick,
    dashboardLinkVisibleBeforeClick: smoke.dashboardLinkVisibleBeforeClick,
    dashboardLinkWasTopBar: smoke.dashboardLinkWasTopBar,
    dashboardLinkClicked: smoke.dashboardLinkClicked,
    locationAfterClick: smoke.locationAfterClick,
    documentReloaded: smoke.documentReloaded,
    weatherLocationText: smoke.weatherLocationText,
    weatherTemperatureText: smoke.weatherTemperatureText,
    weatherConditionText: smoke.weatherConditionText,
    todayHeadingVisible: smoke.todayHeadingVisible,
    exploreWardrobeLinkVisible: smoke.exploreWardrobeLinkVisible,
    navigationVisibleBeforeClick: smoke.navigationVisibleBeforeClick,
    navigationVisibleAfterClick: smoke.navigationVisibleAfterClick,
    dashboardLinkVisibleAfterClick: smoke.dashboardLinkVisibleAfterClick,
    dashboardLinkDisplay: smoke.dashboardLinkDisplay,
    settingUpWardrobeAfterClick: smoke.settingUpWardrobeAfterClick,
    navigationViolations: smoke.navigationViolations,
  });
  result.fixture.requests = fixture.requestCount();
  result.duration_ms = Date.now() - startedAt;

  if (channel === 'webdriver' && sessionId !== null) {
    screenshot = await captureScreenshot(sessionId);
  }

  assertSmoke(smoke);

  result.status = 'passed';
  result.duration_ms = Date.now() - startedAt;

  await writeCacheListing(smoke.cachePath);
  if (screenshot !== null) {
    await writeFile(join(ARTIFACTS_DIRECTORY, 'screenshot.png'), screenshot);
  }
  await writeResult(result);

  console.log(`packaged smoke passed in ${result.duration_ms} ms (evidence channel: ${channel})`);
  if (channel === 'file') {
    console.log(`  note: WebDriver attach was unavailable; the app wrote the same result to ${resultPath}`);
    console.log('  note: no screenshot exists in file mode');
  }
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
