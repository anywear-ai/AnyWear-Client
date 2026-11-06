import { createRoot } from 'react-dom/client';
import { appDataDir, join } from '@tauri-apps/api/path';
import { exists, writeFile } from '@tauri-apps/plugin-fs';
import CachedImage from '../src/components/CachedImage';

// Smoke-only entry, built to `dist-smoke/` and never shipped. It mounts the real
// `CachedImage` twice against a loopback fixture so the packaged run can prove the
// narrowed capability, the asset protocol and the production CSP:
//
// 1. cold mount: `exists()` is false, so the component downloads the fixture and
//    writes it under the app-data cache directory through `writeFile`
// 2. remount with a changed React `key`: `exists()` is true, so the component paints
//    from `convertFileSrc` and does not touch the network again
//
// The same result object is published twice, through two independent channels:
//
// - `window.__smoke`, read by WebDriver `execute/sync` on a non-elevated runner
// - `$APPDATA/cache/images/smoke-result.json`, written through the very capability
//   under test (`fs:allow-write-file` on `$APPDATA/cache/images/**`) so a hosted,
//   elevated Windows runner — where WebView2 refuses the EdgeDriver attach — can
//   still read the same facts from a file. Neither channel carries a fact the
//   other does not; the file is the same JSON object plus the `channel` marker.

const FIXTURE_URL = 'http://127.0.0.1:38471/fixture.png';
const CACHE_KEY = 'smoke-fixture';
const RESULT_FILE = 'smoke-result.json';
const MOUNT_TIMEOUT_MS = 30_000;
const WATCHDOG_TIMEOUT_MS = 90_000;

interface CapturedViolation {
  directive: string;
  blockedURI: string;
}

interface SmokeResult {
  schema_version: 1;
  done: true;
  channel: 'page';
  cachePath: string;
  existsAfter: boolean;
  imgSrc: string;
  naturalWidth: number;
  violations: CapturedViolation[];
  fetchBlocked: boolean;
}

interface SmokeFailure {
  schema_version: 1;
  done: false;
  channel: 'page';
  error: string;
}

declare global {
  interface Window {
    __smoke?: SmokeResult | SmokeFailure;
  }
}

const violations: CapturedViolation[] = [];
document.addEventListener(
  'securitypolicyviolation',
  (event) => {
    violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
  },
  { capture: true },
);

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('smoke/index.html must provide #root');
const root = createRoot(rootElement);
let settled = false;
let cacheDirectory = '';

/** Writes either channel's payload through the capability under test. */
async function writeResultFile(payload: SmokeResult | SmokeFailure): Promise<void> {
  const path = await join(cacheDirectory, RESULT_FILE);
  await writeFile(path, new TextEncoder().encode(`${JSON.stringify(payload)}\n`));
}

async function publishFailure(message: string): Promise<void> {
  if (settled) return;
  settled = true;
  const failure: SmokeFailure = { schema_version: 1, done: false, channel: 'page', error: message };
  if (cacheDirectory !== '') {
    try {
      await writeResultFile(failure);
    } catch {
      // The failure file is best effort; the window channel still carries the error.
    }
  }
  window.__smoke = failure;
}

/** Mount the component and resolve once its `<img>` reports a load. */
function mountImage(mountId: number): Promise<{ src: string; naturalWidth: number }> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timeout = window.setTimeout(() => {
      if (finished) return;
      finished = true;
      reject(new Error(`image mount ${mountId} did not load within ${MOUNT_TIMEOUT_MS} ms`));
    }, MOUNT_TIMEOUT_MS);

    const finish = (value: { src: string; naturalWidth: number }): void => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeout);
      resolve(value);
    };
    const rejectWith = (message: string): void => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeout);
      reject(new Error(message));
    };

    root.render(
      <CachedImage
        key={mountId}
        src={FIXTURE_URL}
        cacheKey={CACHE_KEY}
        id="smoke-image"
        alt="AnyWear packaged smoke fixture"
        onLoad={(event) => {
          const image = event.currentTarget;
          finish({ src: image.currentSrc || image.src, naturalWidth: image.naturalWidth });
        }}
        onError={() => rejectWith(`image mount ${mountId} failed to load`)}
      />,
    );
  });
}

/** An origin the production policy does not admit; the smoke policy does not either. */
async function probeFetchBlocked(): Promise<boolean> {
  try {
    await fetch('https://example.com/fixture.png', { mode: 'no-cors', cache: 'no-store' });
    return false;
  } catch {
    return true;
  }
}

async function run(): Promise<void> {
  try {
    const appData = await appDataDir();
    cacheDirectory = await join(appData, 'cache', 'images');
    const cachePath = await join(cacheDirectory, `${CACHE_KEY}.jpg`);

    // Cold mount: the fixture is downloaded and written through the capability.
    await mountImage(1);
    const existsAfter = await exists(cachePath);

    // Remount through a changed key: a cache hit paints from the asset protocol.
    const cached = await mountImage(2);

    const snapshot = [...violations];
    const fetchBlocked = await probeFetchBlocked();

    const result: SmokeResult = {
      schema_version: 1,
      done: true,
      channel: 'page',
      cachePath,
      existsAfter,
      imgSrc: cached.src,
      naturalWidth: cached.naturalWidth,
      violations: snapshot,
      fetchBlocked,
    };

    // File channel first, so a partially written file is never published as a
    // success by the window channel; both carry the same object.
    await writeResultFile(result);
    if (settled) return;
    settled = true;
    window.__smoke = result;
  } catch (error) {
    await publishFailure(error instanceof Error ? error.message : String(error));
  }
}

window.setTimeout(() => {
  void publishFailure(`smoke entry did not finish within ${WATCHDOG_TIMEOUT_MS} ms`);
}, WATCHDOG_TIMEOUT_MS);
void run();
