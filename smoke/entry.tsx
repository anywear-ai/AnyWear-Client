import { createRoot } from 'react-dom/client';
import { appDataDir, join } from '@tauri-apps/api/path';
import { exists, writeFile } from '@tauri-apps/plugin-fs';
import '../src/lib/amplify';
import App from '../src/App';
import CachedImage from '../src/components/CachedImage';
import { seedAmplifySession } from '../browser/fixture-session';
import './smoke.css';

// Smoke-only entry, built to `dist-smoke/` and never shipped.
//
// Phase 1 mounts the real `CachedImage` twice against a loopback fixture so the
// packaged run can prove the narrowed capability, the asset protocol and the
// production CSP:
//
// 1. cold mount: `exists()` is false, so the component downloads the fixture and
//    writes it under the app-data cache directory through `writeFile`
// 2. remount with a changed React `key`: `exists()` is true, so the component paints
//    from `convertFileSrc` and does not touch the network again
//
// Phase 2 unmounts the image root, seeds the unsigned fixture session, opens
// `/wardrobe` and mounts the real `src/App.tsx` route tree. It then clicks the top
// link bar's Dashboard link once and records the navigation facts the packaged
// script asserts: the routed page rendered before the click, the link was visible
// and was the top bar's, the location became `/dashboard` without a document
// reload, the dashboard rendered its own content, the navigation stayed visible,
// and no `securitypolicyviolation` was recorded during the navigation phase.
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
const APP_MOUNT_TIMEOUT_MS = 30_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const WATCHDOG_TIMEOUT_MS = 150_000;

// Recorded at entry start and persisted in `sessionStorage`, which survives a
// document reload but starts empty on a fresh app launch. A plain `window` field
// could not prove "no reload": the reload would reset it to 1 as well.
const boots = Number(sessionStorage.getItem('anywear-smoke-boots') ?? '0') + 1;
sessionStorage.setItem('anywear-smoke-boots', String(boots));

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
  boots: number;
  wardrobeRenderedBeforeClick: boolean;
  dashboardLinkVisibleBeforeClick: boolean;
  dashboardLinkWasTopBar: boolean;
  dashboardLinkClicked: boolean;
  locationAfterClick: string;
  documentReloaded: boolean;
  weatherLocationText: string;
  weatherTemperatureText: string;
  weatherConditionText: string;
  todayHeadingVisible: boolean;
  exploreWardrobeLinkVisible: boolean;
  navigationVisibleBeforeClick: boolean;
  navigationVisibleAfterClick: boolean;
  dashboardLinkVisibleAfterClick: boolean;
  dashboardLinkDisplay: string;
  settingUpWardrobeAfterClick: boolean;
  navigationViolations: CapturedViolation[];
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

function requireRootElement(): HTMLElement {
  const element = document.getElementById('root');
  if (element === null) throw new Error('smoke/index.html must provide #root');
  return element;
}

const rootElement = requireRootElement();
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

// --- phase 2: the real app tree -------------------------------------------

function isVisible(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0
    && rect.height > 0
    && style.display !== 'none'
    && style.visibility !== 'hidden';
}

function topNavigation(): HTMLElement | null {
  return document.querySelector<HTMLElement>('nav:not([aria-label="Mobile navigation"])');
}

function findHeading(text: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('h1, h2, h3')]
    .find((element) => element.textContent?.trim() === text) ?? null;
}

function findExactText(text: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('span, p, a, div')]
    .find((element) => element.childElementCount === 0 && element.textContent?.trim() === text)
    ?? null;
}

function findTopDashboardLink(): HTMLAnchorElement | null {
  const topBar = topNavigation();
  if (topBar === null) return null;
  return [...topBar.querySelectorAll<HTMLAnchorElement>('a')]
    .find((link) => link.getAttribute('href') === '/dashboard'
      && link.textContent?.trim() === 'Dashboard') ?? null;
}

function dashboardContentPresent(): boolean {
  return findExactText('Hangzhou, Zhejiang') !== null
    && findExactText('22°C') !== null
    && findHeading('Today') !== null
    && findExactText('Explore your wardrobe') !== null;
}

function waitFor(condition: () => boolean, timeoutMs: number, description: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      try {
        if (condition()) {
          resolve();
          return;
        }
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(description));
        return;
      }
      window.setTimeout(check, 50);
    };
    check();
  });
}

/** The dashboard content facts, read from the rendered page. */
function dashboardFacts() {
  const conditionLine = [...document.querySelectorAll<HTMLElement>('p')]
    .find((element) => element.textContent?.includes('Feels like'));
  const exploreLink = [...document.querySelectorAll<HTMLAnchorElement>('a')]
    .find((link) => link.textContent?.trim() === 'Explore your wardrobe') ?? null;
  return {
    locationText: findExactText('Hangzhou, Zhejiang')?.textContent?.trim() ?? '',
    temperatureText: findExactText('22°C')?.textContent?.trim() ?? '',
    conditionText: conditionLine?.textContent?.split('·')[0]?.trim() ?? '',
    todayHeadingVisible: isVisible(findHeading('Today')),
    exploreWardrobeLinkVisible: isVisible(exploreLink),
  };
}

async function run(): Promise<void> {
  try {
    const appData = await appDataDir();
    cacheDirectory = await join(appData, 'cache', 'images');
    const cachePath = await join(cacheDirectory, `${CACHE_KEY}.jpg`);

    // Phase 1 — cold mount: the fixture is downloaded and written through the capability.
    await mountImage(1);
    const existsAfter = await exists(cachePath);

    // Remount through a changed key: a cache hit paints from the asset protocol.
    const cached = await mountImage(2);

    const snapshot = [...violations];
    const fetchBlocked = await probeFetchBlocked();
    // The blocked probe queues a `securitypolicyviolation` event that dispatches
    // after the fetch promise settles. Flush it before the phase boundary so the
    // navigation phase can only contain violations the app itself caused.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const navigationViolationStart = violations.length;

    // Phase 2 — replace the image root with the real app tree.
    root.unmount();
    seedAmplifySession(window.localStorage);
    window.history.replaceState({}, '', '/wardrobe');
    const appRoot = createRoot(rootElement);
    appRoot.render(<App />);

    await waitFor(
      () => findHeading('Wardrobe') !== null,
      APP_MOUNT_TIMEOUT_MS,
      'the Wardrobe page did not render after the app mounted',
    );
    const wardrobeRenderedBeforeClick = findHeading('Wardrobe') !== null;
    const dashboardLink = findTopDashboardLink();
    const navigationVisibleBeforeClick = isVisible(topNavigation());
    const dashboardLinkVisibleBeforeClick = isVisible(dashboardLink);
    const dashboardLinkDisplay = dashboardLink === null
      ? ''
      : getComputedStyle(dashboardLink).display;
    const dashboardLinkWasTopBar = dashboardLink !== null
      && dashboardLink.closest('nav') === topNavigation();

    dashboardLink?.click();
    const dashboardLinkClicked = dashboardLink !== null;

    await waitFor(
      () => window.location.pathname === '/dashboard' && dashboardContentPresent(),
      NAVIGATION_TIMEOUT_MS,
      'the dashboard did not render after clicking the top bar Dashboard link',
    );

    const facts = dashboardFacts();
    const locationAfterClick = window.location.pathname;
    const navigationVisibleAfterClick = isVisible(topNavigation());
    const dashboardLinkVisibleAfterClick = isVisible(findTopDashboardLink());
    const settingUpWardrobeAfterClick = document.body.textContent
      ?.includes('Setting up your wardrobe...') ?? false;

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
      boots,
      wardrobeRenderedBeforeClick,
      dashboardLinkVisibleBeforeClick,
      dashboardLinkWasTopBar,
      dashboardLinkClicked,
      locationAfterClick,
      documentReloaded: boots !== 1,
      weatherLocationText: facts.locationText,
      weatherTemperatureText: facts.temperatureText,
      weatherConditionText: facts.conditionText,
      todayHeadingVisible: facts.todayHeadingVisible,
      exploreWardrobeLinkVisible: facts.exploreWardrobeLinkVisible,
      navigationVisibleBeforeClick,
      navigationVisibleAfterClick,
      dashboardLinkVisibleAfterClick,
      dashboardLinkDisplay,
      settingUpWardrobeAfterClick,
      navigationViolations: violations.slice(navigationViolationStart),
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
