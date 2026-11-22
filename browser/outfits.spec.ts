import { test, expect, type Locator, type Page } from '@playwright/test';
import type { GetOutfits200OutfitsItem } from '../src/api/model/getOutfits200OutfitsItem';
import type { GetVtoBasePhotos200Item } from '../src/api/model/getVtoBasePhotos200Item';
import type { GetWardrobe200Item } from '../src/api/model/getWardrobe200Item';
import { mockClientBoundaries, expectOnlyMockedCalls } from './mock-boundaries';
import { mockAmplifySession } from './auth-session';

const OUTFIT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM_ID_1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ITEM_ID_2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BASE_PHOTO_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const GENERATION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const FITTING_ROOM_ID = '11111111-1111-4111-8111-111111111111';
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

/** The one base photo the Fitting Room preselects through its `isDefault` flag. */
const mockBasePhoto: GetVtoBasePhotos200Item = {
  id: BASE_PHOTO_ID,
  userId: 'test-user-id',
  imageId: 'image-base-photo',
  url: 'https://example.com/base-photo.jpg',
  isDefault: true,
  source: 'user',
  createdAt: '2026-06-01T00:00:00.000Z',
};

interface MockState {
  outfits: GetOutfits200OutfitsItem[];
  mutations: Array<{ method: string; path: string; body: unknown }>;
  /** When set, DELETE /outfits/{id} answers 502 OBJECT_DELETION_INCOMPLETE with these keys. */
  deleteRetainedObjectKeys?: string[];
  /** Issue 313 — the ids staged in the open room, in the order they were added. */
  stagedItemIds?: string[];
}

/** The open room as the Service returns it: its staged members carry `addedAt`. */
function fittingRoomDetail(state: MockState) {
  const stagedIds = state.stagedItemIds ?? [];
  return {
    id: FITTING_ROOM_ID,
    userId: 'test-user-id',
    name: 'Fitting Room',
    isDefault: true,
    itemCount: stagedIds.length,
    createdAt: '2026-05-01T00:00:00.000Z',
    items: stagedIds.map((id) => {
      const item = mockWardrobeItems.find((candidate) => candidate.id === id)!;
      return { ...item, archivedAt: null, addedAt: '2026-06-02T00:00:00.000Z' };
    }),
  };
}

function fittingRoomSummary(state: MockState) {
  const detail = fittingRoomDetail(state);
  return {
    id: detail.id,
    userId: detail.userId,
    name: detail.name,
    isDefault: detail.isDefault,
    itemCount: detail.itemCount,
    createdAt: detail.createdAt,
  };
}

function outfitItems(ids: string[]) {
  return mockWardrobeItems.filter(item => ids.includes(item.id)).map(({ id, name, category, images }) => ({ id, name, category, images }));
}

/**
 * The stand-in for the Service's derivation rule: with no name supplied, the
 * returned outfit is named after its selected pieces. Only the Service tests
 * prove the production rule; here the mock exists so the Client must render
 * whatever name the response carries instead of inventing its own.
 */
function derivedOutfitName(ids: string[]) {
  return outfitItems(ids).map(({ name, category }) => name?.trim() || category.trim()).join(', ');
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
    // Issue 313 — the Fitting Room's room read and its staging area. The list read
    // is the one that creates the default room; the detail read returns its rows.
    if (method === 'GET' && path === '/fitting-rooms') return json({ fittingRooms: [fittingRoomSummary(state)] });
    if (method === 'GET' && path === `/fitting-rooms/${FITTING_ROOM_ID}`) return json(fittingRoomDetail(state));
    if (method === 'POST' && path === `/fitting-rooms/${FITTING_ROOM_ID}/items`) {
      const body = request.postDataJSON() as { wearable_item_ids: string[] };
      state.stagedItemIds = [...new Set([...(state.stagedItemIds ?? []), ...body.wearable_item_ids])];
      return json(fittingRoomDetail(state));
    }
    const removedItemId = path.startsWith(`/fitting-rooms/${FITTING_ROOM_ID}/items/`)
      ? path.split('/').pop()
      : undefined;
    if (method === 'DELETE' && removedItemId) {
      state.stagedItemIds = (state.stagedItemIds ?? []).filter((id) => id !== removedItemId);
      return route.fulfill({ status: 204 });
    }
    if (method === 'GET' && path === '/vto/base-photos') return json([]);
    if (method === 'GET' && path === '/vto/generations') return json({ generations: [], total: 0, page: 1, limit: 12, nextPage: null });
    // A generation start opens the same status read and stream the Fitting Room uses;
    // the terminal frame ends the stream and is what the test ends on.
    const completedStatus = (generationId: string) => ({
      generation_id: generationId,
      status: 'Complete',
      state_version: 1,
      imageId: null,
      url: null,
      created_at: '2026-06-01T00:00:00.000Z',
      rating: null,
    });
    const streamedGenerationId = path.match(/^\/vto\/generations\/([^/]+)\/stream$/)?.[1];
    if (method === 'GET' && streamedGenerationId) {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `event: status\ndata: ${JSON.stringify(completedStatus(streamedGenerationId))}\n\n`,
      });
    }
    const generationId = path.match(/^\/vto\/generations\/([^/]+)$/)?.[1];
    if (method === 'GET' && generationId) return json(completedStatus(generationId));
    if (method === 'POST' && path === '/vto/generations') {
      const body = request.postDataJSON();
      state.mutations.push({ method, path, body });
      return json({ generation_id: GENERATION_ID, outfit_id: body.outfit_id }, 202);
    }
    // Issue 335 — the item-mode selection asks whether the set is already saved.
    if (method === 'GET' && path === '/outfits/lookup') return json({ outfit: null });
    const id = path.match(/^\/outfits\/([^/]+)$/)?.[1];
    if (method === 'POST' && path === '/outfits') {
      const body = request.postDataJSON();
      state.mutations.push({ method, path, body });
      // Issue 313 — the save path renders nothing: the row it returns has
      // `latestGeneration` and `look` both null, which is the never-generated state.
      // `201` on a new set and `200` on an existing one are both success, and the
      // generated client resolves either 2xx to this same body.
      const existing = state.outfits.find(
        (candidate) => JSON.stringify(candidate.wearableItems?.map((item) => item.id))
          === JSON.stringify(body.wearable_item_ids),
      );
      if (existing) return json(existing, 200);
      const outfit = {
        ...structuredClone(mockOutfit),
        name: body.name ?? derivedOutfitName(body.wearable_item_ids),
        wearableItems: outfitItems(body.wearable_item_ids),
        latestGeneration: null,
        look: null,
        generationCount: 0,
      };
      state.outfits.push(outfit);
      return json(outfit, 201);
    }
    if (id && method === 'PATCH') {
      const body = request.postDataJSON();
      state.mutations.push({ method, path, body });
      const outfit = state.outfits.find(outfit => outfit.id === id);
      if (!outfit) return json({ error: 'NOT_FOUND' }, 404);
      // Issue 332 — members are frozen. The Service's schema is strict, so a body
      // that still names them is a 400 with the key in the issue message, and no
      // row is written.
      if ('wearable_item_ids' in body) {
        return json({
          error: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: [{ path: '', message: "Unrecognized key(s) in object: 'wearable_item_ids'" }],
        }, 400);
      }
      outfit.name = body.name ?? outfit.name;
      return json(outfit);
    }
    if (id && method === 'DELETE') {
      state.mutations.push({ method, path, body: undefined });
      state.outfits = state.outfits.filter(outfit => outfit.id !== id);
      // The rows are deleted either way: a 502 only says the Service still owes
      // the stored-image absence proof to its cleanup manifest.
      if (state.deleteRetainedObjectKeys?.length) {
        return json({
          error: 'OBJECT_DELETION_INCOMPLETE',
          message: 'The outfit was deleted; stored images are still owed by an open cleanup manifest.',
          details: {
            manifest_id: '99999999-9999-4999-8999-999999999999',
            retained_object_keys: state.deleteRetainedObjectKeys,
          },
        }, 502);
      }
      return route.fulfill({ status: 204 });
    }
    return route.fallback();
  });
}

function outfitCard(page: Page, name: string) {
  return page.getByRole('heading', { name, exact: true }).locator('..').locator('..');
}

/**
 * The whole card article. `outfitCard` stops at the edit button, which does not
 * contain the action row; this scope reaches both the cover and its action.
 */
function outfitArticle(page: Page, name: string) {
  return page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
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

  /**
   * Issue 313 — the Wardrobe no longer creates an outfit, so the one new path this
   * suite gains goes through the compose step: stage a piece in the room, tick it,
   * turn `Try it on now` off and press `Save outfit`. The request is the member
   * list alone — no base photo, no prompt, no name, no idempotency key — and the
   * card the Wardrobe then paints is the never-generated state, not a failure.
   */
  test('saves a ticked set through the compose step and lands its card in the never-generated state', async ({ page }) => {
    const state: MockState = { outfits: [], mutations: [], stagedItemIds: [] };
    await setupOutfitMocks(page, state);
    await page.goto('/fitting-room');
    await expect(page.getByRole('heading', { level: 1, name: 'Fitting Room' })).toBeVisible();

    await page.getByRole('button', { name: 'Add T-Shirt to try on', exact: true }).click();
    await expect(page.getByTestId('to-try-on-row')).toHaveCount(1);
    // The Wardrobe tile states the staged set itself, so the room's membership is
    // readable from that area alone; the name flips to the removal it will perform.
    const wardrobe = page.getByRole('region', { name: 'Wardrobe', exact: true });
    await expect(wardrobe.getByRole('button', { name: 'Remove T-Shirt from try on', exact: true }))
      .toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Select T-Shirt', exact: true }).click();

    // Off: the primary button is Save outfit, and it states that nothing is charged.
    await page.getByRole('switch', { name: 'Try it on now (1 credit)' }).click();
    await expect(page.getByText('No credit is charged for saving an outfit.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save outfit', exact: true }).click();

    await expect.poll(() => state.mutations.length).toBe(1);
    const [{ method, path, body }] = state.mutations;
    expect(method).toBe('POST');
    expect(path).toBe('/outfits');
    // postDataJSON re-parses the exact request bytes, so the key list is the proof
    // that no base photo, prompt, name or idempotency field reached the wire.
    expect(Object.keys(body as Record<string, unknown>)).toEqual(['wearable_item_ids']);
    expect(body).toEqual({ wearable_item_ids: [ITEM_ID_1] });

    // To try on survives the compose attempt: the same pieces are still staged.
    await expect(page.getByTestId('to-try-on-row')).toHaveCount(1);

    const name = derivedOutfitName([ITEM_ID_1]);
    await page.goto('/wardrobe');
    // Scoped by the card's own action, because a wardrobe item can share the
    // outfit's derived name (`T-Shirt`) and is a different article.
    const card = page.getByRole('article').filter({
      has: page.getByRole('button', { name: `Generate look for ${name}`, exact: true }),
    });
    await expect(card.getByText('1 items', { exact: true })).toBeVisible();
    await expect(card.getByTestId('outfit-cover-placeholder')).toBeVisible();
    await expect(card.getByText('No look yet', { exact: true })).toBeVisible();
    await expect(card.getByText('Image unavailable', { exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: `Generate look for ${name}`, exact: true })).toBeVisible();
    // The placeholder is the Client's own graphic: no image is requested for it.
    await expect(card.getByRole('img')).toHaveCount(0);
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

  test('generates a try-on from the ticked To try on rows whose wire body has no outfit name', async ({ page }) => {
    const state: MockState = { outfits: [], mutations: [], stagedItemIds: [] };
    await setupOutfitMocks(page, state);
    // The default mock lists no base photos; this scenario needs the flagged
    // default so the Fitting Room preselects it and the generate control enables.
    await page.route('**/vto/base-photos', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([mockBasePhoto]),
    }));
    await page.goto('/fitting-room');

    await expect(page.getByRole('button', { name: 'Selected base photo 1, default', exact: true })).toBeVisible();
    // Staging adds the row; ticking is the separate act that decides what is tried.
    await page.getByRole('button', { name: 'Add T-Shirt to try on', exact: true }).click();
    await page.getByRole('button', { name: 'Select T-Shirt', exact: true }).click();
    const generateButton = page.getByRole('button', { name: 'Generate try-on', exact: true });
    await expect(generateButton).toBeEnabled();
    await generateButton.click();

    await expect.poll(() => state.mutations.length).toBe(1);
    const [{ method, path, body }] = state.mutations;
    expect(method).toBe('POST');
    expect(path).toBe('/vto/generations');
    // postDataJSON re-parses the exact request bytes, so this key list is the
    // proof that the optional blank outfit name never reached the wire.
    expect(Object.keys(body as Record<string, unknown>).sort()).toEqual(['base_photo_id', 'wearable_item_ids']);
    expect(Object.keys(body as Record<string, unknown>)).not.toContain('outfit_name');
    expect(body).toMatchObject({ base_photo_id: BASE_PHOTO_ID, wearable_item_ids: [ITEM_ID_1] });
  });

  test('adds a piece with the keyboard, then ticks it in To try on and exposes the pressed state', async ({ page }) => {
    const state: MockState = { outfits: [], mutations: [], stagedItemIds: [] };
    await setupOutfitMocks(page, state);
    await page.goto('/fitting-room');

    const add = page.getByRole('button', { name: 'Add T-Shirt to try on' });
    await add.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('to-try-on-row')).toHaveCount(1);

    const tick = page.getByRole('button', { name: 'Select T-Shirt' });
    await tick.focus();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('button', { name: 'Selected T-Shirt', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('to-try-on-counter')).toHaveText('1 / 5');
    // Ticking is view state: it sends nothing.
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
    const state: MockState = { outfits: [structuredClone(mockOutfit)], mutations: [] };
    await setupOutfitMocks(page, state);
    await page.goto('/wardrobe');

    const opener = page.getByRole('button', { name: 'Edit Weekend Casual', exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Edit Outfit' });
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
      { name: 'Edit Outfit', open: () => page.getByRole('button', { name: 'Edit Weekend Casual', exact: true }).click() },
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
    expect(state.mutations).toEqual([{ method: 'PATCH', path: `/outfits/${OUTFIT_ID}`, body: { name: 'Updated Name' } }]);
  });

  test('deletes an outfit after confirmation and shows the empty state', async ({ page }) => {
    const state: MockState = {
      outfits: [{ ...structuredClone(mockOutfit), generationCount: 2 }],
      mutations: [],
    };
    await setupOutfitMocks(page, state);
    await page.goto('/wardrobe');
    await page.getByRole('heading', { name: 'Weekend Casual', exact: true }).click();
    await page.getByRole('button', { name: 'Delete Outfit', exact: true }).click();
    // The confirmation states the one count the Service returned, then the
    // existing warning; the DELETE itself answers 204 with no body.
    await expect(page.getByText('Delete this outfit? It has 2 try-on records. Its looks stay in your history. This cannot be undone.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByText('No outfits yet', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Weekend Casual', exact: true })).not.toBeVisible();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    expect(state.mutations).toEqual([{ method: 'DELETE', path: `/outfits/${OUTFIT_ID}`, body: undefined }]);
  });

  /**
   * Issue 332 — a running try-on refuses the outfit delete.
   *
   * The confirmation keeps its control disabled and says which attempt is running;
   * there is no forced delete, and nothing is sent.
   */
  test('disables the confirmation while a try-on is running and sends nothing', async ({ page }) => {
    const state: MockState = {
      outfits: [{
        ...structuredClone(mockOutfit),
        latestGeneration: { id: 'generation-1', status: 'Pending', errorCode: null, createdAt: '2026-06-02T00:00:00.000Z' },
      }],
      mutations: [],
    };
    await setupOutfitMocks(page, state);
    await page.goto('/wardrobe');
    await page.getByRole('heading', { name: 'Weekend Casual', exact: true }).click();
    await page.getByRole('button', { name: 'Delete Outfit', exact: true }).click();

    await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
    await expect(page.getByText(/still running for this outfit/)).toBeVisible();
    expect(state.mutations).toEqual([]);
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
  test('paints each outfit cover state with its own action', async ({ page }) => {
    const state: MockState = {
      outfits: [
        // A completed look with a signed url: the image, and New look.
        { ...structuredClone(mockOutfit), id: '11111111-1111-4111-8111-111111111111', name: 'Look Outfit', generationCount: 2 },
        // A running generation without a look: the skeleton, and no action.
        {
          ...structuredClone(mockOutfit),
          id: '22222222-2222-4222-8222-222222222222',
          name: 'Running Outfit',
          latestGeneration: { id: GENERATION_ID, status: 'Processing', errorCode: null, createdAt: '2026-06-02T00:00:00.000Z' },
          look: null,
        },
        // A failed last generation without a look: the failure sentence, and Retry.
        {
          ...structuredClone(mockOutfit),
          id: '33333333-3333-4333-8333-333333333333',
          name: 'Failed Outfit',
          latestGeneration: { id: GENERATION_ID, status: 'Failed', errorCode: 'base_photo_unavailable', createdAt: '2026-06-02T00:00:00.000Z' },
          look: null,
        },
        // A completed look whose url was not signed: Image unavailable, and New look.
        {
          ...structuredClone(mockOutfit),
          id: '44444444-4444-4444-8444-444444444444',
          name: 'Unsigned Outfit',
          latestGeneration: { id: GENERATION_ID, status: 'Complete', errorCode: null, createdAt: '2026-06-01T00:00:00.000Z' },
          look: { generationId: GENERATION_ID, url: null, createdAt: '2026-06-01T00:00:00.000Z' },
        },
        // No generation at all: No look yet, and Generate look.
        {
          ...structuredClone(mockOutfit),
          id: '55555555-5555-4555-8555-555555555555',
          name: 'Empty Outfit',
          latestGeneration: null,
          look: null,
        },
      ],
      mutations: [],
    };
    await setupOutfitMocks(page, state);
    await page.goto('/wardrobe');

    const look = outfitArticle(page, 'Look Outfit');
    await expect(look.getByRole('img', { name: 'Look Outfit' })).toHaveAttribute('src', LOOK_IMAGE);
    await expect(look.getByRole('button', { name: 'New look for Look Outfit', exact: true })).toBeVisible();

    const running = outfitArticle(page, 'Running Outfit');
    const skeleton = running.getByTestId('outfit-cover-skeleton-22222222-2222-4222-8222-222222222222');
    await expect(skeleton).toBeVisible();
    await expect(skeleton).toHaveAttribute('aria-busy', 'true');
    await expect(running.getByText('Generating…', { exact: true })).toBeVisible();
    await expect(running.getByRole('button', { name: /for Running Outfit/ })).toHaveCount(0);

    const failed = outfitArticle(page, 'Failed Outfit');
    await expect(failed.getByText('Last try-on failed', { exact: true })).toBeVisible();
    await expect(failed.getByRole('button', { name: 'Retry for Failed Outfit', exact: true })).toBeVisible();

    const unsigned = outfitArticle(page, 'Unsigned Outfit');
    await expect(unsigned.getByText('Image unavailable', { exact: true })).toBeVisible();
    await expect(unsigned.getByRole('button', { name: 'New look for Unsigned Outfit', exact: true })).toBeVisible();
    await expect(unsigned.getByRole('img')).toHaveCount(0);

    const empty = outfitArticle(page, 'Empty Outfit');
    await expect(empty.getByText('No look yet', { exact: true })).toBeVisible();
    await expect(empty.getByRole('button', { name: 'Generate look for Empty Outfit', exact: true })).toBeVisible();

    expect(state.mutations).toEqual([]);
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
      { name: 'Edit Outfit', opener: page.getByRole('button', { name: 'Edit Outfit 1', exact: true }) },
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

  test('stays locked through the real outfit-rename to look-dialog handoff', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 520 });
    const state: MockState = { outfits: scrollingOutfits(6), mutations: [] };
    await setupOutfitMocks(page, state);
    await page.goto('/wardrobe');

    const editButton = page.getByRole('button', { name: 'Edit Outfit 1', exact: true });
    const before = await scrollOpenerIntoView(page, editButton);
    expect(before, 'the mocked page did not scroll').toBeGreaterThan(0);
    await clickByPointer(page, editButton);

    const outfitDialog = page.getByRole('dialog', { name: 'Edit Outfit' });
    await expect(outfitDialog).toBeVisible();
    await page.getByPlaceholder('e.g. Weekend Casual').fill('Office Ready');
    await outfitDialog.getByRole('button', { name: 'Save Changes', exact: true }).click();

    // The rename closes the outfit dialog and opens the look confirmation; the
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
      { method: 'PATCH', path: '/outfits/ffffffff-ffff-4fff-8fff-000000000000', body: { name: 'Office Ready' } },
    ]);
  });
});
