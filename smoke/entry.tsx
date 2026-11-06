import { createRoot } from 'react-dom/client';
import { appDataDir, join } from '@tauri-apps/api/path';
import { exists } from '@tauri-apps/plugin-fs';
import CachedImage from '../src/components/CachedImage';

// Smoke-only entry, built to `dist-smoke/` and never shipped. It mounts the real
// `CachedImage` twice against a loopback fixture so the packaged WebDriver run can
// prove the narrowed capability, the asset protocol and the production CSP:
//
// 1. cold mount: `exists()` is false, so the component downloads the fixture and
//    writes it under the app-data cache directory through `writeFile`
// 2. remount with a changed React `key`: `exists()` is true, so the component paints
//    from `convertFileSrc` and does not touch the network again
//
// `window.__smoke` is the only result channel: WebDriver reads it with
// `execute/sync`, so CSP evidence does not depend on a console-log channel.

const FIXTURE_URL = 'http://127.0.0.1:38471/fixture.png';
const CACHE_KEY = 'smoke-fixture';
const MOUNT_TIMEOUT_MS = 30_000;
const WATCHDOG_TIMEOUT_MS = 90_000;

interface CapturedViolation {
  directive: string;
  blockedURI: string;
}

interface SmokeSuccess {
  done: true;
  cachePath: string;
  existsAfter: boolean;
  imgSrc: string;
  naturalWidth: number;
  violations: CapturedViolation[];
  fetchBlocked: boolean;
}

interface SmokeFailure {
  done: false;
  error: string;
}

declare global {
  interface Window {
    __smoke?: SmokeSuccess | SmokeFailure;
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

function fail(message: string): void {
  if (settled) return;
  settled = true;
  window.__smoke = { done: false, error: message };
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
    const cachePath = await join(appData, 'cache', 'images', `${CACHE_KEY}.jpg`);

    // Cold mount: the fixture is downloaded and written through the capability.
    await mountImage(1);
    const existsAfter = await exists(cachePath);

    // Remount through a changed key: a cache hit paints from the asset protocol.
    const cached = await mountImage(2);

    const snapshot = [...violations];
    const fetchBlocked = await probeFetchBlocked();
    if (settled) return;
    settled = true;
    window.__smoke = {
      done: true,
      cachePath,
      existsAfter,
      imgSrc: cached.src,
      naturalWidth: cached.naturalWidth,
      violations: snapshot,
      fetchBlocked,
    };
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

window.setTimeout(() => fail(`smoke entry did not finish within ${WATCHDOG_TIMEOUT_MS} ms`), WATCHDOG_TIMEOUT_MS);
void run();
