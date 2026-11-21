import { test, expect, type Page } from '@playwright/test';
import type { GetWardrobe200Item } from '../src/api/model/getWardrobe200Item';
import { mockClientBoundaries, mockFittingRoom, expectOnlyMockedCalls } from './mock-boundaries';
import { mockAmplifySession } from './auth-session';

const ITEM_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ROOM_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const mockItems: GetWardrobe200Item[] = [
  { id: ITEM_ID, ownerId: 'test-user-id', name: 'T-Shirt', category: 'Top', images: [{ imageId: 'image-tshirt', url: 'https://example.com/tshirt.jpg', view: null, isPrimary: true }], taggingStatus: 'ready', weatherTags: [], styleAttributes: {}, isPublic: false, imageEmbedding: null, taggingStateVersion: 1, taggingErrorCode: null, taggingErrorMessage: null, createdAt: '2026-05-05T00:00:00.000Z', updatedAt: '2026-05-05T00:00:00.000Z' },
  { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', ownerId: 'test-user-id', name: 'Jeans', category: 'Bottom', images: [], taggingStatus: 'ready', weatherTags: [], styleAttributes: {}, isPublic: false, imageEmbedding: null, taggingStateVersion: 1, taggingErrorCode: null, taggingErrorMessage: null, createdAt: '2026-05-05T00:00:00.000Z', updatedAt: '2026-05-05T00:00:00.000Z' },
];

async function setupMocks(page: Page) {
  await mockClientBoundaries(page);
  await mockAmplifySession(page);
  // Issue 313 — the Fitting Room's room reads, from the shared boundary helper.
  await mockFittingRoom(page, { id: ROOM_ID });
  await page.route('http://localhost:3000/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    const responses: Record<string, unknown> = {
      '/users/me': { id: 'test-user-id', email: 'test@anywear.local', dailyCredits: 10 },
      '/wardrobe': mockItems,
      '/wardrobe/categories': { categories: ['Top', 'Bottom'] },
      '/outfits': { outfits: [] },
      '/vto/base-photos': [],
      '/vto/generations': { generations: [], total: 0, page: 1, limit: 12, nextPage: null },
    };
    if (path in responses) {
      return json(responses[path]);
    }
    await route.fallback();
  });
}

test('wardrobe and Fitting Room layouts fit target browser widths', async ({ page }, testInfo) => {
  await setupMocks(page);
  const layouts = [
    { width: 390, wardrobeColumns: 2, wearableColumns: 2 },
    { width: 768, wardrobeColumns: 4, wearableColumns: 4 },
    { width: 1440, wardrobeColumns: 5, wearableColumns: 4 },
  ];

  for (const layout of layouts) {
    await page.setViewportSize({ width: layout.width, height: 900 });
    await page.goto('/wardrobe');
    const wardrobeGrid = page.locator('.grid-cols-2').filter({ has: page.getByRole('button', { name: 'View T-Shirt details' }) }).first();
    await expect(page.getByRole('button', { name: 'View T-Shirt details' })).toBeVisible();
    await expect.poll(async () => (await wardrobeGrid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length))).toBe(layout.wardrobeColumns);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`wardrobe-${layout.width}.png`), fullPage: true });

    await page.goto('/fitting-room');
    await expect(page.getByRole('heading', { level: 1, name: 'Fitting Room' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Wardrobe', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'To try on', exact: true })).toBeVisible();
    // The platform, not the width, decides the entry set: every width keeps the
    // one Upload entry the web build renders.
    await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Take photo' })).toHaveCount(0);
    const wearableGrid = page.getByTestId('room-wardrobe-grid');
    await expect(page.getByRole('button', { name: 'Add T-Shirt to try on' })).toBeVisible();
    await expect.poll(async () => (await wearableGrid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length))).toBe(layout.wearableColumns);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`fitting-room-${layout.width}.png`), fullPage: true });
  }
});

test.afterEach(({ page }) => expectOnlyMockedCalls(page));
