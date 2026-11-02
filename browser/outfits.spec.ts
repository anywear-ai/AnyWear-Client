import { test, expect, type Locator, type Page } from '@playwright/test';
import type { GetOutfits200OutfitsItem } from '../src/api/model/getOutfits200OutfitsItem';
import type { GetWardrobe200Item } from '../src/api/model/getWardrobe200Item';
import { mockClientBoundaries, expectOnlyMockedCalls } from './mock-boundaries';
import { mockAmplifySession } from './auth-session';

const OUTFIT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM_ID_1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ITEM_ID_2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GENERATION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PRIMARY_IMAGE = 'https://example.com/tshirt-primary.jpg';
const LOOK_IMAGE = 'https://example.com/outfit-look.png';

const mockOutfit: GetOutfits200OutfitsItem = {
  id: OUTFIT_ID, userId: 'test-user-id', name: 'Weekend Casual', createdAt: '2026-05-05T00:00:00.000Z',
  wearableItems: [
    { id: ITEM_ID_1, name: 'T-Shirt', category: 'Top', images: [
      { imageId: 'image-tshirt-other', url: 'https://example.com/tshirt-other.jpg', view: null, isPrimary: false },
      { imageId: 'image-tshirt-primary', url: PRIMARY_IMAGE, view: null, isPrimary: true },
    ] },
    { id: ITEM_ID_2, name: 'Jeans', category: 'Bottom', images: [] },
  ],
  latestGeneration: { id: GENERATION_ID, status: 'Complete', errorCode: null, createdAt: '2026-06-01T00:00:00.000Z' },
  look: { generationId: GENERATION_ID, url: LOOK_IMAGE, createdAt: '2026-06-01T00:00:00.000Z' },
};

const mockWardrobeItems: GetWardrobe200Item[] = [
  { id: ITEM_ID_1, ownerId: 'test-user-id', name: 'T-Shirt', category: 'Top', images: [{ imageId: 'image-tshirt-primary', url: PRIMARY_IMAGE, view: null, isPrimary: true }], taggingStatus: 'ready', weatherTags: [], styleAttributes: {}, isPublic: false, imageEmbedding: null, taggingStateVersion: 1, taggingErrorCode: null, taggingErrorMessage: null, createdAt: '2026-05-05T00:00:00.000Z', updatedAt: '2026-05-05T00:00:00.000Z' },
  { id: ITEM_ID_2, ownerId: 'test-user-id', name: 'Jeans', category: 'Bottom', images: [{ imageId: 'image-jeans', url: 'https://example.com/jeans.jpg', view: null, isPrimary: true }], taggingStatus: 'ready', weatherTags: [], styleAttributes: {}, isPublic: false, imageEmbedding: null, taggingStateVersion: 1, taggingErrorCode: null, taggingErrorMessage: null, createdAt: '2026-05-05T00:00:00.000Z', updatedAt: '2026-05-05T00:00:00.000Z' },
];

interface MockState {
  outfits: GetOutfits200OutfitsItem[];
  mutations: Array<{ method: string; path: string; body: unknown }>;
}

function outfitItems(ids: string[]) {
  return mockWardrobeItems.filter(item => ids.includes(item.id)).map(({ id, name, category, images }) => ({ id, name, category, images }));
}

async function setupOutfitMocks(page: Page, state: MockState) {
  await mockClientBoundaries(page);
  await page.route('http://localhost:3000/**', async (route, request) => {
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (method === 'GET' && path === '/users/me') return json({ id: 'test-user-id', email: 'test@anywear.local', dailyCredits: 10 });
    if (method === 'GET' && path === '/wardrobe') return json(mockWardrobeItems);
    if (method === 'GET' && path === '/wardrobe/categories') return json({ categories: ['Top', 'Bottom'] });
    if (method === 'GET' && path === '/outfits') return json({ outfits: state.outfits });
    if (method === 'GET' && path === '/vto/base-photos') return json([]);
    if (method === 'GET' && path === '/vto/generations') return json({ generations: [], total: 0, page: 1, limit: 12, nextPage: null });
    if (method === 'POST' && path === '/vto/generations') {
      const body = request.postDataJSON();
      state.mutations.push({ method, path, body });
      return json({ generation_id: GENERATION_ID, outfit_id: body.outfit_id }, 202);
    }
    const id = path.match(/^\/outfits\/([^/]+)$/)?.[1];
    if (method === 'POST' && path === '/outfits') {
      const body = request.postDataJSON();
      state.mutations.push({ method, path, body });
      const outfit = { ...structuredClone(mockOutfit), name: body.name ?? null, wearableItems: outfitItems(body.wearable_item_ids) };
      state.outfits.push(outfit);
      return json(outfit, 201);
    }
    if (id && method === 'PATCH') {
      const body = request.postDataJSON();
      state.mutations.push({ method, path, body });
      const outfit = state.outfits.find(outfit => outfit.id === id);
      if (!outfit) return json({ error: 'NOT_FOUND' }, 404);
      outfit.name = body.name ?? outfit.name;
      outfit.wearableItems = outfitItems(body.wearable_item_ids);
      return json(outfit);
    }
    if (id && method === 'DELETE') {
      state.mutations.push({ method, path, body: undefined });
      state.outfits = state.outfits.filter(outfit => outfit.id !== id);
      return json({ success: true });
    }
    return route.fallback();
  });
}

function outfitCard(page: Page, name: string) {
  return page.getByRole('heading', { name, exact: true }).locator('..').locator('..');
}

/** The dialogs' focusable stops, matching the shared dialog hook's selector. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Enough outfit cards that the mocked wardrobe page scrolls at a 520px-tall viewport. */
function scrollingOutfits(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    ...structuredClone(mockOutfit),
    id: `ffffffff-ffff-4fff-8fff-${String(index).padStart(12, '0')}`,
    name: `Outfit ${index + 1}`,
  }));
}

/**
 * Scrolls the opener to the middle of the viewport and returns the resulting
 * non-zero offset. A top-of-document opener would otherwise leave scrollY at 0;
 * a short downward scroll keeps it clickable and proves the lock preserves a
 * non-zero position.
 */
async function scrollOpenerIntoView(page: Page, opener: Locator) {
  await opener.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  let offset = await page.evaluate(() => window.scrollY);
  if (offset === 0) {
    await page.evaluate(() => window.scrollTo(0, 40));
    offset = await page.evaluate(() => window.scrollY);
  }
  return offset;
}

/** Clicks at the opener's current viewport position so Playwright cannot scroll it into view. */
async function clickByPointer(page: Page, opener: Locator) {
  const box = await opener.boundingBox();
  expect(box, 'the opener has no layout box').not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

/** Wheels over the backdrop area, outside every dialog panel. */
async function wheelOutsidePanel(page: Page) {
  await page.mouse.move(20, 20);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(150);
}

/**
 * The computed focus treatment of the active stop. The Add Item file input is
 * visually hidden, so its ring is the wrapping label's `focus-within` shadow.
 */
async function activeStopRing(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return null;
    const target = active instanceof HTMLInputElement && active.type === 'file'
      ? (active.closest('label') as HTMLElement | null)
      : active;
    if (!target) return null;

    const token = getComputedStyle(document.documentElement).getPropertyValue('--color-indigo-500').trim()
      || 'oklch(58.5% 0.233 277.117)';
    const probe = document.createElement('div');
    probe.style.color = token;
    document.body.appendChild(probe);
    const indigo = getComputedStyle(probe).color;
    probe.remove();

    return {
      tag: active.tagName,
      name: active.getAttribute('aria-label') ?? active.textContent?.trim().slice(0, 48) ?? '',
      boxShadow: getComputedStyle(target).boxShadow,
      indigo,
    };
  });
}

async function expectActiveStopRing(page: Page, context: string) {
  // Some dialog controls carry Tailwind's `transition`, so the page's computed
  // box-shadow settles a frame or two after focus moves. Poll for the settled
  // value instead of sampling the transition's first frame.
  await expect
    .poll(
      async () => {
        const ring = await activeStopRing(page);
        if (!ring) return 'nothing is focused';
        const hasWidth = ring.boxShadow.includes('2px');
        const hasIndigo = ring.boxShadow.includes(ring.indigo);
        return hasWidth && hasIndigo
          ? 'ring'
          : `${ring.tag} "${ring.name}" box-shadow: ${ring.boxShadow} (expected 2px and ${ring.indigo})`;
      },
      { message: `${context}: the active stop never painted a 2px indigo ring`, timeout: 2000 },
    )
    .toBe('ring');
}

/** Tabs once through every stop and asserts the painted ring on each, including the wrap. */
async function expectEveryTabStopRing(page: Page, panel: Locator, context: string) {
  const stopCount = await panel.evaluate(
    (dialog, selector) => Array.from(dialog.querySelectorAll(selector))
      // A `display: none` input matches the selector but is not a tab stop.
      .filter((element) => element.getClientRects().length > 0).length,
    FOCUSABLE_SELECTOR,
  );
  expect(stopCount, `${context}: no focusable stops`).toBeGreaterThan(0);

  for (let index = 0; index < stopCount; index += 1) {
    await expectActiveStopRing(page, `${context} stop ${index + 1}/${stopCount}`);
    await page.keyboard.press('Tab');
  }
  await expectActiveStopRing(page, `${context} wrap`);
}

/**
 * The dialog's backdrop is the `[role="dialog"]` panel's preceding sibling. The
 * computed `background-color` serializes as `oklab(… / 0.75)` rather than
 * `rgba(…)`, so the rendered alpha is read by painting the computed color onto a
 * 1×1 canvas and multiplying the pixel alpha by the computed opacity.
 */
async function backdropPaint(page: Page, dialogName: string) {
  const backdrop = page
    .getByRole('dialog', { name: dialogName })
    .locator('xpath=preceding-sibling::*[1]');
  return backdrop.evaluate((element) => {
    const style = getComputedStyle(element);
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.fillStyle = style.backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return {
      color: style.backgroundColor,
      alpha: (context.getImageData(0, 0, 1, 1).data[3] / 255) * Number(style.opacity),
    };
  });
}

test.describe('Outfit Management (mocked Client integration)', () => {
  test.beforeEach(async ({ page }) => {
    await mockAmplifySession(page);
  });
  test.afterEach(({ page }) => expectOnlyMockedCalls(page));

  test('creates an outfit, then offers the confirmed look action on the saved card', async ({ page }) => {
    const state: MockState = { outfits: [], mutations: [] };
    await setupOutfitMocks(page, state);
    await page.goto('/wardrobe');
    await page.getByRole('button', { name: 'Create Outfit', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Create Outfit' })).toBeVisible();
    await page.getByPlaceholder('e.g. Weekend Casual').fill('Office Ready');
    await page.getByRole('button', { name: 'T-Shirt', exact: true }).click();
    await page.getByRole('button', { name: 'Jeans', exact: true }).click();
    await page.getByRole('button', { name: 'Create Outfit', exact: true }).last().click();
    await expect(page.getByRole('heading', { name: 'Create Outfit' })).not.toBeVisible();
    await expect(outfitCard(page, 'Office Ready').getByText('2 items', { exact: true })).toBeVisible();
    // The create response is followed by the same confirmation the card offers;
    // cancelling it spends nothing.
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Generate a look for Office Ready?' })).toBeVisible();
    await expect(dialog).toContainText('This uses 1 of your daily credits.');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    expect(state.mutations).toEqual([{ method: 'POST', path: '/outfits', body: { name: 'Office Ready', wearable_item_ids: [ITEM_ID_1, ITEM_ID_2] } }]);
  });

  test('selects a saved outfit in the Mirror picker with its completed look', async ({ page }) => {
    const state: MockState = { outfits: [structuredClone(mockOutfit)], mutations: [] };
    await setupOutfitMocks(page, state);
    await page.goto('/mirror');
    await page.getByRole('button', { name: 'Saved', exact: true }).click();
    const picker = page.getByRole('button', { name: 'Weekend Casual 2 items', exact: true });
    await expect(picker).toBeVisible();
    await expect(picker.locator('img')).toHaveAttribute('src', LOOK_IMAGE);
    await expect(picker).toHaveAttribute('aria-pressed', 'false');
    await picker.click();
    await expect(picker).toHaveAttribute('aria-pressed', 'true');
    await expect(picker).toHaveClass(/border-indigo-600/);
    expect(state.mutations).toEqual([]);
  });

  test('generates a look only after the confirmation, which omits base_photo_id', async ({ page }) => {
    const state: MockState = { outfits: [structuredClone(mockOutfit)], mutations: [] };
    await setupOutfitMocks(page, state);
    await page.goto('/wardrobe');
    const card = page.getByRole('article').filter({ hasText: 'Weekend Casual' });

    await card.getByRole('button', { name: 'New look for Weekend Casual', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('This uses 1 of your daily credits.');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(state.mutations).toEqual([]);

    await card.getByRole('button', { name: 'New look for Weekend Casual', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Generate look (1 credit)', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    expect(state.mutations).toEqual([{ method: 'POST', path: '/vto/generations', body: { outfit_id: OUTFIT_ID } }]);
  });

  test('selects wardrobe pieces with the keyboard and exposes the pressed state', async ({ page }) => {
    const state: MockState = { outfits: [], mutations: [] };
    await setupOutfitMocks(page, state);
    await page.goto('/mirror');

    const shirt = page.getByRole('button', { name: 'Select T-Shirt' });
    await shirt.focus();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('button', { name: 'Remove T-Shirt', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('1 selected', { exact: true })).toBeVisible();
    expect(state.mutations).toEqual([]);
  });

  test('opens wardrobe item details from the keyboard and restores focus after Escape', async ({ page }) => {
    const state: MockState = { outfits: [], mutations: [] };
    await setupOutfitMocks(page, state);
    await page.goto('/wardrobe');

    const itemButton = page.getByRole('button', { name: 'View T-Shirt details' });
    await itemButton.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Item Details' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(dialog).not.toBeVisible();
    await expect(itemButton).toBeFocused();
    expect(state.mutations).toEqual([]);
  });

  test('keeps keyboard focus inside the add-item dialog', async ({ page }) => {
    const state: MockState = { outfits: [], mutations: [] };
    await setupOutfitMocks(page, state);
    await page.goto('/wardrobe');

    await page.getByRole('button', { name: 'Add Item', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add Wardrobe Item' });
    const close = dialog.getByRole('button', { name: 'Close' });
    const cancel = dialog.getByRole('button', { name: 'Cancel' });
    await expect(dialog).toBeVisible();
    await expect(close).toBeFocused();

    await cancel.focus();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(cancel).toBeFocused();
    expect(state.mutations).toEqual([]);
  });

  test('closes the outfit dialog with Escape and restores focus to its opener', async ({ page }) => {
    const state: MockState = { outfits: [], mutations: [] };
    await setupOutfitMocks(page, state);
    await page.goto('/wardrobe');

    const opener = page.getByRole('button', { name: 'Create Outfit', exact: true }).first();
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Create Outfit' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
    expect(state.mutations).toEqual([]);
  });

  // The jsdom suite cannot paint, so the backdrop's intended appearance is only
  // observable here: each of the four wardrobe dialogs dims the page to the same
  // gray-500 at 75% alpha. A retired spelling leaves the backdrop opaque and fails.
  test('renders a translucent backdrop behind every wardrobe dialog', async ({ page }) => {
    const state: MockState = { outfits: [structuredClone(mockOutfit)], mutations: [] };
    await setupOutfitMocks(page, state);
    await page.goto('/wardrobe');

    const dialogs = [
      { name: 'Add Wardrobe Item', open: () => page.getByRole('button', { name: 'Add Item', exact: true }).click() },
      { name: 'Item Details', open: () => page.getByRole('button', { name: 'View T-Shirt details' }).click() },
      { name: 'Create Outfit', open: () => page.getByRole('button', { name: /Create Outfit/ }).first().click() },
      { name: 'Generate a look for Weekend Casual?', open: () => page.getByRole('button', { name: 'New look for Weekend Casual', exact: true }).click() },
    ];

    const paints: Array<{ name: string; color: string; alpha: number }> = [];
    for (const dialog of dialogs) {
      await dialog.open();
      await expect(page.getByRole('dialog', { name: dialog.name })).toBeVisible();
      paints.push({ name: dialog.name, ...(await backdropPaint(page, dialog.name)) });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: dialog.name })).not.toBeVisible();
    }

    // Every dialog paints the same color at 75% alpha, and none paints opaque.
    for (const paint of paints) {
      expect(paint.alpha, `${paint.name} backdrop alpha`).toBeCloseTo(0.75, 2);
    }
    expect(new Set(paints.map((paint) => paint.color)).size).toBe(1);
    expect(state.mutations).toEqual([]);
  });

  test('edits an outfit name and refreshes its card', async ({ page }) => {
    const state: MockState = { outfits: [{ ...structuredClone(mockOutfit), name: 'Old Name' }], mutations: [] };
    await setupOutfitMocks(page, state);
    await page.goto('/wardrobe');
    await page.getByRole('heading', { name: 'Old Name', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Edit Outfit' })).toBeVisible();
    await expect(page.getByPlaceholder('e.g. Weekend Casual')).toHaveValue('Old Name');
    await page.getByPlaceholder('e.g. Weekend Casual').fill('Updated Name');
    await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Edit Outfit' })).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Updated Name', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Old Name', exact: true })).not.toBeVisible();
    expect(state.mutations).toEqual([{ method: 'PATCH', path: `/outfits/${OUTFIT_ID}`, body: { name: 'Updated Name', wearable_item_ids: [ITEM_ID_1, ITEM_ID_2] } }]);
  });

  test('deletes an outfit after confirmation and shows the empty state', async ({ page }) => {
    const state: MockState = { outfits: [structuredClone(mockOutfit)], mutations: [] };
    await setupOutfitMocks(page, state);
    await page.goto('/wardrobe');
    await page.getByRole('heading', { name: 'Weekend Casual', exact: true }).click();
    await page.getByRole('button', { name: 'Delete Outfit', exact: true }).click();
    await expect(page.getByText('Delete this outfit? This cannot be undone.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByText('No outfits yet', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Weekend Casual', exact: true })).not.toBeVisible();
    expect(state.mutations).toEqual([{ method: 'DELETE', path: `/outfits/${OUTFIT_ID}`, body: undefined }]);
  });

  test('shows outfit-specific counts, the completed look and the empty look state', async ({ page }) => {
    const state: MockState = {
      outfits: [
        structuredClone(mockOutfit),
        {
          ...structuredClone(mockOutfit),
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          name: null,
          wearableItems: [],
          latestGeneration: null,
          look: null,
        },
      ],
      mutations: [],
    };
    await setupOutfitMocks(page, state);
    await page.goto('/wardrobe');
    const saved = outfitCard(page, 'Weekend Casual');
    await expect(saved.getByText('2 items', { exact: true })).toBeVisible();
    await expect(saved.getByRole('img', { name: 'Weekend Casual' })).toHaveAttribute('src', LOOK_IMAGE);
    const empty = outfitCard(page, 'Untitled Outfit');
    await expect(empty.getByText('0 items', { exact: true })).toBeVisible();
    await expect(empty.getByText('No look yet', { exact: true })).toBeVisible();
    // The outfit's first garment is never used as the outfit's image.
    await expect(empty.getByRole('img')).toHaveCount(0);
  });
});

// jsdom cannot scroll or paint, so the scroll lock and the focus treatment are
// observed here: the wheel must not move a pre-scrolled page behind any dialog,
// the offset must survive the close, and every stop must compute a 2px indigo
// ring even on the first programmatically focused stop after a pointer open.
test.describe('Wardrobe dialog scroll lock and focus rings (mocked Client integration)', () => {
  test.beforeEach(async ({ page }) => {
    await mockAmplifySession(page);
  });
  test.afterEach(({ page }) => expectOnlyMockedCalls(page));

  test('holds a pre-scrolled offset through all four dialogs and rings every tab stop', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 520 });
    const state: MockState = { outfits: scrollingOutfits(6), mutations: [] };
    await setupOutfitMocks(page, state);
    await page.goto('/wardrobe');
    await expect(page.getByRole('heading', { name: 'Wardrobe', exact: true })).toBeVisible();

    const dialogs = [
      { name: 'Add Wardrobe Item', opener: page.getByRole('button', { name: 'Add Item', exact: true }) },
      { name: 'Item Details', opener: page.getByRole('button', { name: 'View T-Shirt details' }) },
      { name: 'Create Outfit', opener: page.getByRole('button', { name: '+ Create Outfit', exact: true }) },
      { name: 'Generate a look for Outfit 1?', opener: page.getByRole('button', { name: 'New look for Outfit 1', exact: true }) },
    ];

    for (const dialog of dialogs) {
      const before = await scrollOpenerIntoView(page, dialog.opener);
      expect(before, `${dialog.name}: the mocked page did not scroll`).toBeGreaterThan(0);

      // A real pointer click sets the pointer modality, so the first stop's ring
      // proves `:focus` paints where `:focus-visible` would not.
      await clickByPointer(page, dialog.opener);
      const panel = page.getByRole('dialog', { name: dialog.name });
      await expect(panel).toBeVisible();

      expect(await page.evaluate(() => document.body.style.overflow), `${dialog.name}: body overflow`).toBe('hidden');
      expect(await page.evaluate(() => window.scrollY), `${dialog.name}: opening moved the page`).toBe(before);

      await expectActiveStopRing(page, `${dialog.name}: pointer-opened first stop`);

      await wheelOutsidePanel(page);
      expect(await page.evaluate(() => window.scrollY), `${dialog.name}: wheel moved the locked page`).toBe(before);

      await expectEveryTabStopRing(page, panel, dialog.name);

      await page.keyboard.press('Escape');
      await expect(panel).not.toBeVisible();

      // The offset survives the close before any further wheel, exactly.
      expect(await page.evaluate(() => document.body.style.overflow), `${dialog.name}: body overflow after close`).toBe('');
      expect(await page.evaluate(() => window.scrollY), `${dialog.name}: closing moved the page`).toBe(before);

      await wheelOutsidePanel(page);
      expect(await page.evaluate(() => window.scrollY), `${dialog.name}: the page did not scroll after close`).toBeGreaterThan(before);
    }

    expect(state.mutations).toEqual([]);
  });

  test('stays locked through the real outfit-save to look-dialog handoff', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 520 });
    const state: MockState = { outfits: scrollingOutfits(6), mutations: [] };
    await setupOutfitMocks(page, state);
    await page.goto('/wardrobe');

    const createButton = page.getByRole('button', { name: '+ Create Outfit', exact: true });
    const before = await scrollOpenerIntoView(page, createButton);
    expect(before, 'the mocked page did not scroll').toBeGreaterThan(0);
    await clickByPointer(page, createButton);

    const outfitDialog = page.getByRole('dialog', { name: 'Create Outfit' });
    await expect(outfitDialog).toBeVisible();
    await outfitDialog.getByRole('button', { name: 'T-Shirt', exact: true }).click();
    await outfitDialog.getByRole('button', { name: 'Jeans', exact: true }).click();
    await page.getByPlaceholder('e.g. Weekend Casual').fill('Office Ready');
    await outfitDialog.getByRole('button', { name: 'Create Outfit', exact: true }).click();

    // The save closes the outfit dialog and opens the look confirmation; the
    // page must stay locked because the look dialog still holds the count.
    const lookDialog = page.getByRole('dialog', { name: 'Generate a look for Office Ready?' });
    await expect(lookDialog).toBeVisible();
    await expect(outfitDialog).not.toBeVisible();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    expect(await page.evaluate(() => window.scrollY)).toBe(before);

    await wheelOutsidePanel(page);
    expect(await page.evaluate(() => window.scrollY)).toBe(before);

    await lookDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(lookDialog).not.toBeVisible();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
    expect(await page.evaluate(() => window.scrollY)).toBe(before);

    await wheelOutsidePanel(page);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(before);

    expect(state.mutations).toEqual([
      { method: 'POST', path: '/outfits', body: { name: 'Office Ready', wearable_item_ids: [ITEM_ID_1, ITEM_ID_2] } },
    ]);
  });
});
