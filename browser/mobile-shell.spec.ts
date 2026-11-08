import { test, expect, type Page } from '@playwright/test';
import type { GetWardrobe200Item } from '../src/api/model/getWardrobe200Item';
import { mockClientBoundaries, expectOnlyMockedCalls } from './mock-boundaries';
import { mockAmplifySession } from './auth-session';

const ITEM_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const mockItems: GetWardrobe200Item[] = [
  {
    id: ITEM_ID,
    ownerId: 'test-user-id',
    name: 'T-Shirt',
    category: 'Top',
    images: [{ imageId: 'image-tshirt', url: 'https://example.com/tshirt.jpg', view: null, isPrimary: true }],
    taggingStatus: 'ready',
    weatherTags: [],
    styleAttributes: {},
    isPublic: false,
    imageEmbedding: null,
    taggingStateVersion: 1,
    taggingErrorCode: null,
    taggingErrorMessage: null,
    createdAt: '2026-05-05T00:00:00.000Z',
    updatedAt: '2026-05-05T00:00:00.000Z',
  },
];

async function setupMocks(page: Page) {
  await mockClientBoundaries(page);
  await mockAmplifySession(page);
  await page.route('http://localhost:3000/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/users/me': { id: 'test-user-id', email: 'test@anywear.local', dailyCredits: 10 },
      '/wardrobe': mockItems,
      '/wardrobe/categories': { categories: ['Top', 'Bottom'] },
      '/outfits': { outfits: [] },
      '/vto/base-photos': [],
      '/vto/generations': { generations: [], total: 0, page: 1, limit: 12, nextPage: null },
    };
    if (path in responses) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(responses[path]) });
    } else {
      await route.fallback();
    }
  });
}

test('the 390 px shell clears the bottom navigation and carries the touch layer', async ({ page }) => {
  await setupMocks(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/wardrobe');
  await expect(page.getByRole('button', { name: 'View T-Shirt details' })).toBeVisible();

  // The viewport opts into the notch area; the Android shell consumes the inset
  // (MainActivity padding), so CSS has no `env(safe-area-inset-*)` duplicate.
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);

  // Main content reserves at least the fixed bottom bar's height below the last
  // card, so nothing is trapped underneath it.
  const paddingBottom = await page
    .locator('main')
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom));
  const navHeight = await page
    .getByRole('navigation', { name: 'Mobile navigation' })
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(navHeight).toBeGreaterThan(0);
  expect(paddingBottom).toBeGreaterThanOrEqual(navHeight);

  // Controls drop the double-tap zoom and the tap delay.
  await expect
    .poll(() => page.getByRole('button', { name: 'View T-Shirt details' }).evaluate((element) => getComputedStyle(element).touchAction))
    .toBe('manipulation');

  // Wardrobe imagery cannot be selected or long-pressed into a callout; the
  // editable fields in the details dialog keep text selection.
  await expect.poll(() => page.locator('img').first().evaluate((element) => getComputedStyle(element).userSelect)).toBe('none');

  await page.getByRole('button', { name: 'View T-Shirt details' }).click();
  await expect(page.getByRole('dialog', { name: 'Item Details' })).toBeVisible();
  await expect
    .poll(() => page.getByRole('textbox', { name: 'Name' }).evaluate((element) => getComputedStyle(element).userSelect))
    .toBe('text');
  await page.keyboard.press('Escape');

  // Both capture entries are visible in the Add dialog at this width.
  await page.getByRole('button', { name: 'Add Item' }).click();
  await expect(page.getByText('Choose from library')).toBeVisible();
  await expect(page.getByText('Take photo')).toBeVisible();
});

test.afterEach(({ page }) => expectOnlyMockedCalls(page));
