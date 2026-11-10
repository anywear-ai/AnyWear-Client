import type { Page } from '@playwright/test';
import { seedAmplifySession } from './fixture-session';

export { MOCK_USER_POOL_ID, MOCK_USER_POOL_CLIENT_ID } from './fixture-session';

/**
 * Seed the SDK's session input with unsigned fixture tokens; all Service/cloud
 * calls stay mocked.
 *
 * The seed itself lives in `fixture-session.ts` with no Playwright import, so the
 * packaged smoke can call the same function with `window.localStorage`. Here it
 * is serialised into the page, because an init script cannot close over module
 * values.
 */
export async function mockAmplifySession(page: Page, expiresIn = 86_400) {
  await page.addInitScript({
    content: `(${seedAmplifySession.toString()})(localStorage, ${expiresIn})`,
  });
}
