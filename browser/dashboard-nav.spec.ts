import { test, expect, type Page } from '@playwright/test';
import { mockClientBoundaries, expectOnlyMockedCalls } from './mock-boundaries';
import { mockAmplifySession } from './auth-session';

const WEATHER = {
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

type Layout = 'top' | 'mobile';

interface ViewportCase {
  name: string;
  width: number;
  height: number;
  layout: Layout;
}

const VIEWPORTS: ViewportCase[] = [
  { name: '1280x720', width: 1280, height: 720, layout: 'top' },
  { name: '375x667', width: 375, height: 667, layout: 'mobile' },
];

interface NavFrame {
  top: boolean;
  mobile: boolean;
}

interface NavSampleState {
  frames: NavFrame[];
  running: boolean;
  raf: number;
}

declare global {
  interface Window {
    __boots?: number;
    __documentBoots?: number;
    __navSamples?: NavSampleState;
  }
}

async function mockService(page: Page) {
  await mockClientBoundaries(page);
  await mockAmplifySession(page);
  await page.route('http://localhost:3000/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/users/me': { id: 'test-user-id', email: 'test@anywear.local', dailyCredits: 10 },
      '/wardrobe': [],
      '/wardrobe/categories': { categories: [] },
      '/outfits': { outfits: [] },
      '/weather/current': WEATHER,
    };
    if (!(path in responses)) return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(responses[path]),
    });
  });
}

function topLink(page: Page) {
  // The first <nav> is the top link bar; the mobile bar names itself.
  return page.locator('nav').first().getByRole('link', { name: 'Dashboard', exact: true });
}

function mobileNav(page: Page) {
  return page.getByRole('navigation', { name: 'Mobile navigation' });
}

function layoutDashboardLink(page: Page, layout: Layout) {
  return layout === 'top'
    ? topLink(page)
    : mobileNav(page).getByRole('link', { name: 'Dashboard', exact: true });
}

/** The navigation the viewport must show, and the one it must not. */
async function expectLayoutNavigation(page: Page, layout: Layout) {
  if (layout === 'top') {
    await expect(topLink(page)).toBeVisible();
    await expect(mobileNav(page)).toBeHidden();
  } else {
    await expect(mobileNav(page)).toBeVisible();
    await expect(topLink(page)).toBeHidden();
  }
}

async function installBootCounter(page: Page) {
  await page.addInitScript(() => {
    window.__boots = (window.__boots ?? 0) + 1;
    // A `window` counter alone cannot detect a reload: a new document resets it
    // to 1 again. The sessionStorage copy survives the reload, so the assertion
    // can tell "one document" from "reloaded".
    const documentBoots = Number(sessionStorage.getItem('anywear-document-boots') ?? '0') + 1;
    sessionStorage.setItem('anywear-document-boots', String(documentBoots));
    window.__documentBoots = documentBoots;
  });
}

async function readBoots(page: Page): Promise<{ window: number; document: number }> {
  return page.evaluate(() => ({
    window: window.__boots ?? 0,
    document: window.__documentBoots ?? 0,
  }));
}

/**
 * Samples the two navigation surfaces on every animation frame, in the page, so
 * "visible on every sampled frame" is a measured fact rather than a pair of
 * before/after assertions.
 */
async function startNavigationSampler(page: Page) {
  await page.evaluate(() => {
    const visible = (element: Element | null): boolean => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden';
    };

    const state: NavSampleState = { frames: [], running: true, raf: 0 };
    window.__navSamples = state;
    const tick = () => {
      if (!state.running) return;
      const topBar = document.querySelector('nav:not([aria-label="Mobile navigation"])');
      state.frames.push({
        top: visible(topBar?.querySelector('a[href="/dashboard"]') ?? null),
        mobile: visible(document.querySelector('nav[aria-label="Mobile navigation"]')),
      });
      state.raf = requestAnimationFrame(tick);
    };
    state.raf = requestAnimationFrame(tick);
  });
}

async function stopNavigationSampler(page: Page): Promise<NavFrame[]> {
  return page.evaluate(() => {
    const state = window.__navSamples;
    if (!state) return [];
    state.running = false;
    cancelAnimationFrame(state.raf);
    return state.frames;
  });
}

async function openWardrobe(page: Page, viewport: ViewportCase) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto('/wardrobe');
  await expect(page.getByRole('heading', { name: 'Wardrobe', exact: true })).toBeVisible();
}

async function expectDashboardContent(page: Page) {
  await expect(page.getByText('Hangzhou, Zhejiang'))
    .toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('22°C')).toBeVisible();
  await expect(page.getByText('Sunny')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Explore your wardrobe' })).toBeVisible();
}

test.afterEach(({ page }) => expectOnlyMockedCalls(page));

test.describe('cold route chunk', () => {
  for (const viewport of VIEWPORTS) {
    test(`one click shows a named page-area wait and then the dashboard at ${viewport.name}`, async ({ page }) => {
      await mockService(page);
      await installBootCounter(page);
      await page.route('**/DashboardPage.tsx*', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        await route.continue();
      });

      await openWardrobe(page, viewport);
      await startNavigationSampler(page);
      await layoutDashboardLink(page, viewport.layout).click();

      // The wait names the destination and leaves the layout's navigation in place.
      await expect(page.getByText('Loading dashboard...', { exact: true })).toBeVisible({ timeout: 5_000 });
      await expectLayoutNavigation(page, viewport.layout);

      await expectDashboardContent(page);

      // The same layout navigation is still there, and the other one never showed.
      await expectLayoutNavigation(page, viewport.layout);
      await expect(page.getByText('Loading dashboard...', { exact: true })).toBeHidden();

      const frames = await stopNavigationSampler(page);
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frame).toEqual(
          viewport.layout === 'top'
            ? { top: true, mobile: false }
            : { top: false, mobile: true },
        );
      }

      // One click, no document reload.
      expect(await readBoots(page)).toEqual({ window: 1, document: 1 });
      await expect(page).toHaveURL(/\/dashboard$/);
    });
  }
});

test.describe('route chunk failing to load', () => {
  for (const viewport of VIEWPORTS) {
    test(`an in-page error card recovers by reload at ${viewport.name}`, async ({ page }) => {
      await mockService(page);
      await installBootCounter(page);
      await page.route('**/DashboardPage.tsx*', (route) => route.fulfill({
        status: 404,
        contentType: 'text/plain',
        body: 'not found',
      }));

      await openWardrobe(page, viewport);
      await layoutDashboardLink(page, viewport.layout).click();

      // The failure is a page-area card, not a replacement of the shell.
      const errorCard = page.getByRole('alert');
      await expect(errorCard).toHaveCount(1);
      await expect(errorCard).toContainText("This page didn't load");
      await expect(errorCard).toContainText(
        'The page could not be loaded. Check your connection and reload the app.',
      );
      await expectLayoutNavigation(page, viewport.layout);

      // Module now answers 200; the card's reload control recovers.
      await page.unroute('**/DashboardPage.tsx*');
      await page.getByRole('button', { name: 'Reload' }).click();

      await expectDashboardContent(page);
      await expectLayoutNavigation(page, viewport.layout);
      // The recovery was a document reload: the reload-proof counter is now 2
      // while the new document's own window counter is 1.
      expect(await readBoots(page)).toEqual({ window: 1, document: 2 });
    });
  }
});

test.describe('dashboard navigation without injection', () => {
  for (const viewport of VIEWPORTS) {
    test(`the reported path renders the dashboard content in one click at ${viewport.name}`, async ({ page }) => {
      await mockService(page);
      await installBootCounter(page);

      await openWardrobe(page, viewport);
      await layoutDashboardLink(page, viewport.layout).click();

      await expectDashboardContent(page);
      await expectLayoutNavigation(page, viewport.layout);
      await expect(page.getByRole('alert')).toHaveCount(0);
      expect(await readBoots(page)).toEqual({ window: 1, document: 1 });
      await expect(page).toHaveURL(/\/dashboard$/);
    });
  }
});
