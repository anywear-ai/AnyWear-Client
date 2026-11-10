import { test, expect, type Page } from '@playwright/test';
import { mockAmplifySession, MOCK_USER_POOL_CLIENT_ID } from './auth-session';
import { mockClientBoundaries, expectOnlyMockedCalls } from './mock-boundaries';

const PERSISTED_REFRESH_TOKEN_KEY =
  `CognitoIdentityServiceProvider.${MOCK_USER_POOL_CLIENT_ID}.test-user.refreshToken`;

interface ViewportCase {
  name: string;
  width: number;
  height: number;
  layout: 'top' | 'mobile';
}

// No viewport shows both navigation surfaces: the top link bar hides below
// `sm` (640 px) and the Mobile navigation bar hides at `sm` and above.
const VIEWPORTS: ViewportCase[] = [
  { name: '1280x720', width: 1280, height: 720, layout: 'top' },
  { name: '375x667', width: 375, height: 667, layout: 'mobile' },
];

function topDashboardLink(page: Page) {
  return page.locator('nav').first().getByRole('link', { name: 'Dashboard', exact: true });
}

function mobileNav(page: Page) {
  return page.getByRole('navigation', { name: 'Mobile navigation' });
}

async function expectLayoutNavigation(page: Page, layout: ViewportCase['layout']) {
  if (layout === 'top') {
    await expect(topDashboardLink(page)).toBeVisible();
    await expect(mobileNav(page)).toBeHidden();
  } else {
    await expect(mobileNav(page)).toBeVisible();
    await expect(topDashboardLink(page)).toBeHidden();
  }
}

async function installBootCounter(page: Page) {
  await page.addInitScript(() => {
    Reflect.set(window, '__boots', (Reflect.get(window, '__boots') ?? 0) + 1);
    // A `window` counter alone cannot detect a reload: a new document resets it.
    // The sessionStorage copy survives within the tab, so the assertion can tell
    // one document from a reload.
    const documentBoots = Number(sessionStorage.getItem('anywear-document-boots') ?? '0') + 1;
    sessionStorage.setItem('anywear-document-boots', String(documentBoots));
    Reflect.set(window, '__documentBoots', documentBoots);
  });
}

async function readBoots(page: Page): Promise<{ window: number; document: number }> {
  return page.evaluate(() => ({
    window: Number(Reflect.get(window, '__boots') ?? 0),
    document: Number(Reflect.get(window, '__documentBoots') ?? 0),
  }));
}

const WEATHER_FIXTURE = {
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

/** The dashboard's own content, independent of the profile read's state. */
async function expectDashboardSurface(page: Page) {
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Explore your wardrobe' })).toBeVisible();
  await expect(page.getByText('Hangzhou, Zhejiang')).toBeVisible();
  await expect(page.getByText('22°C')).toBeVisible();
  await expect(page.getByText('Sunny')).toBeVisible();
}

async function mockProtectedRequests(page: Page, profileStatus = 200) {
  const calls: Array<{ path: string; authorization?: string }> = [];
  await mockClientBoundaries(page);
  await page.route('http://localhost:3000/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    calls.push({ path, authorization: request.headers().authorization });
    const responses: Record<string, unknown> = {
      '/users/me': { id: 'test-user-id', email: 'test@anywear.local' },
      '/wardrobe': [],
      '/wardrobe/categories': { categories: [] },
      '/outfits': { outfits: [] },
      '/weather/top-cities': { locations: [] },
      '/weather/current': WEATHER_FIXTURE,
    };
    if (!(path in responses)) return route.fallback();
    return route.fulfill({
      status: path === '/users/me' ? profileStatus : 200,
      contentType: 'application/json',
      body: JSON.stringify(path === '/users/me' && profileStatus !== 200 ? { error: 'PROFILE_UNAVAILABLE' } : responses[path]),
    });
  });
  return calls;
}

test.afterEach(({ page }) => expectOnlyMockedCalls(page));

test('a valid Amplify session refreshes a protected route without rendering login', async ({ page }) => {
  await mockAmplifySession(page);
  const calls = await mockProtectedRequests(page);
  await page.addInitScript(() => {
    const loginRenders: string[] = [];
    Object.assign(window, { loginRenders });
    new MutationObserver(() => {
      if ([...document.querySelectorAll('h3')].some(node => node.textContent === 'Sign in')) {
        loginRenders.push(location.pathname);
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto('/wardrobe');
  await expect(page.getByRole('heading', { name: 'Wardrobe', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Wardrobe', exact: true })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, 'loginRenders'))).toEqual([]);
  expect(calls.filter(call => call.path === '/users/me').length).toBeGreaterThanOrEqual(2);
  expect(calls.every(call => call.authorization?.startsWith('Bearer '))).toBe(true);
  await expect(page).toHaveURL(/\/wardrobe$/);
});

test('logout reports completion only after the SDK sign-out destroyed the session', async ({ page, context }) => {
  await mockAmplifySession(page);
  const calls = await mockProtectedRequests(page);
  await page.goto('/wardrobe');
  await expect(page.getByRole('heading', { name: 'Wardrobe', exact: true })).toBeVisible();
  const profileRequestsBeforeLogout = calls.filter(call => call.path === '/users/me').length;

  // Give the fixture session a revocable access token and a refresh token so the SDK's sign-out
  // performs its revoke request, which this test holds open to observe the in-flight UI state.
  await page.evaluate(({ clientId, username }) => {
    const encode = (payload: Record<string, unknown>) => btoa(JSON.stringify(payload))
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const issued = Math.floor(Date.now() / 1000);
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
      sub: 'test-user-id', 'cognito:username': username, token_use: 'access',
      origin_jti: 'fixture-session', exp: issued + 3600, iat: issued,
    })}.fixture`;
    const prefix = `CognitoIdentityServiceProvider.${clientId}.${username}`;
    localStorage.setItem(`${prefix}.accessToken`, accessToken);
    localStorage.setItem(`${prefix}.refreshToken`, 'fixture-refresh-token');
  }, { clientId: MOCK_USER_POOL_CLIENT_ID, username: 'test-user' });

  let releaseRevoke!: () => void;
  const revokeReleased = new Promise<void>((resolve) => { releaseRevoke = resolve; });
  let observeRevoke!: () => void;
  const revokeRequested = new Promise<void>((resolve) => { observeRevoke = resolve; });
  const corsHeaders = {
    'access-control-allow-origin': 'http://localhost:1420',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': '*',
  };
  await page.route('https://cognito-idp.*.amazonaws.com/**', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: corsHeaders });
    }
    observeRevoke();
    await revokeReleased;
    return route.fulfill({
      status: 200,
      headers: { ...corsHeaders, 'content-type': 'application/x-amz-json-1.1' },
      body: '{}',
    });
  });

  await page.getByRole('button', { name: 'Logout' }).click();
  await revokeRequested;

  // Tokens are still restorable, so the UI must not report a completed logout yet.
  await expect(page.getByRole('button', { name: 'Signing out' })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Wardrobe', exact: true })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), PERSISTED_REFRESH_TOKEN_KEY))
    .toBe('fixture-refresh-token');

  releaseRevoke();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  const persistedKeys = await page.evaluate(() =>
    Object.keys(localStorage).filter(key => key.startsWith('CognitoIdentityServiceProvider.')));
  expect(persistedKeys).toEqual([]);

  // A second document, which the shared session fixture does not re-seed, cannot restore the session.
  const nextDocument = await context.newPage();
  await mockClientBoundaries(nextDocument);
  try {
    await nextDocument.goto('/wardrobe');
    await expect(nextDocument).toHaveURL(/\/login$/);
    await expect(nextDocument.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    expectOnlyMockedCalls(nextDocument);
  } finally {
    await nextDocument.close();
  }
  expect(calls.filter(call => call.path === '/users/me')).toHaveLength(profileRequestsBeforeLogout);
});

test('a stale UI flag cannot admit a protected route without an SDK session', async ({ page }) => {
  const calls = await mockProtectedRequests(page);
  await page.addInitScript(() => localStorage.setItem('isAuthenticated', 'true'));
  await page.goto('/wardrobe');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  expect(calls).toEqual([]);
});

test('direct login navigation preserves a valid SDK session and enters server validation', async ({ page }) => {
  await mockAmplifySession(page);
  const calls = await mockProtectedRequests(page);
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(calls.some(call => call.path === '/users/me')).toBe(true);
});

test('an expired SDK session without refresh credentials does not admit protected routes', async ({ page }) => {
  await mockAmplifySession(page, -60);
  const calls = await mockProtectedRequests(page);
  await page.goto('/wardrobe');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(calls).toEqual([]);
});

for (const viewport of VIEWPORTS) {
  test(`a pending profile read leaves the routed page and navigation usable at ${viewport.name}`, async ({ page }) => {
    await mockAmplifySession(page);
    await mockProtectedRequests(page);
    let releaseProfile!: () => void;
    const profileReady = new Promise<void>(resolve => { releaseProfile = resolve; });
    await page.route('**/users/me', async (route) => {
      await profileReady;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'test-user-id', dailyCredits: 10 }),
      });
    });

    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/dashboard');

    // After the Amplify bootstrap settles, the routed dashboard and the shell
    // render while the profile read is still pending.
    await expectDashboardSurface(page);
    await expectLayoutNavigation(page, viewport.layout);
    await expect(page.getByText('Checking your profile...', { exact: true })).toBeVisible();
    await expect(page.getByText('Setting up your wardrobe...', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Profile Sync Failed' })).toHaveCount(0);

    releaseProfile();
    await expect(page.getByText('Checking your profile...', { exact: true })).toBeHidden();
    await expectDashboardSurface(page);
    await expectLayoutNavigation(page, viewport.layout);
  });

  test(`a failing profile read shows an in-page Retry and recovers without a reload at ${viewport.name}`, async ({ page }) => {
    await mockAmplifySession(page);
    await mockProtectedRequests(page);
    await installBootCounter(page);

    let profileStatus = 500;
    const profileRequests: string[] = [];
    await page.route('**/users/me', async (route) => {
      profileRequests.push(new URL(route.request().url()).pathname);
      await route.fulfill({
        status: profileStatus,
        contentType: 'application/json',
        body: JSON.stringify(
          profileStatus === 200
            ? { id: 'test-user-id', dailyCredits: 10 }
            : { error: 'PROFILE_UNAVAILABLE' },
        ),
      });
    });

    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/dashboard');

    // The failure appears only after the query policy's retry has run, and it
    // sits beside the routed dashboard instead of replacing it.
    const notice = page.getByRole('status').filter({
      hasText: "We couldn't load your profile. Some features may be unavailable until it loads.",
    });
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expectDashboardSurface(page);
    await expectLayoutNavigation(page, viewport.layout);
    await expect(page.getByRole('heading', { name: 'Profile Sync Failed' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();

    const requestsBeforeRetry = profileRequests.length;
    profileStatus = 200;
    await page.getByRole('button', { name: 'Retry' }).click();

    // The retry re-runs the request (not the document): a further GET appears,
    // the notice clears, and the boot counter is still one.
    await expect.poll(() => profileRequests.length).toBeGreaterThan(requestsBeforeRetry);
    await expect(notice).toBeHidden();
    await expectDashboardSurface(page);
    expect(await readBoots(page)).toEqual({ window: 1, document: 1 });
  });
}
