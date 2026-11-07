import { test, expect, type Locator, type Page } from '@playwright/test';
import type { GetVtoGenerations200GenerationsItem } from '../src/api/model/getVtoGenerations200GenerationsItem';
import { mockClientBoundaries, expectOnlyMockedCalls } from './mock-boundaries';
import { mockAmplifySession } from './auth-session';

const UNRATED_ID = '11111111-1111-4111-8111-111111111111';
const RATED_ID = '22222222-2222-4222-8222-222222222222';
const FAILED_ID = '33333333-3333-4333-8333-333333333333';
const RESULT_URL = 'https://example.com/vto-result.png';

const ITEMS = [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'T-Shirt', category: 'Top', images: [] },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Jeans', category: 'Bottom', images: [] },
];

/** The nearest `.group` ancestor of a card descendant is the card root. */
const CARD_ROOT = 'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " group ")][1]';

/**
 * Three history rows, in render order: the unrated `Complete` row carries both a
 * `url` and items, so `View Full` and `Reuse Outfit` co-render; the second row is
 * already rated; the `Failed` row carries no image, so `Retry` renders and
 * `View Full` cannot. The list is the order the mock returns, so index 0/1/2 are
 * these rows.
 */
function historyRows(): GetVtoGenerations200GenerationsItem[] {
  return [
    {
      id: UNRATED_ID,
      createdAt: '2026-11-06T10:00:00.000Z',
      status: 'Complete',
      imageId: 'image-unrated',
      url: RESULT_URL,
      rating: null,
      promptUsed: null,
      advancedSettings: null,
      items: structuredClone(ITEMS),
    },
    {
      id: RATED_ID,
      createdAt: '2026-11-06T09:00:00.000Z',
      status: 'Complete',
      imageId: 'image-rated',
      url: RESULT_URL,
      rating: 4,
      promptUsed: null,
      advancedSettings: null,
      items: structuredClone(ITEMS),
    },
    {
      id: FAILED_ID,
      createdAt: '2026-11-06T08:00:00.000Z',
      status: 'Failed',
      imageId: null,
      url: null,
      rating: null,
      promptUsed: null,
      advancedSettings: null,
      items: structuredClone(ITEMS),
    },
  ];
}

interface RatingRequest {
  method: string;
  path: string;
  body: unknown;
}

interface MirrorState {
  generations: GetVtoGenerations200GenerationsItem[];
  ratingRequests: RatingRequest[];
}

function createState(): MirrorState {
  return { generations: historyRows(), ratingRequests: [] };
}

/**
 * The `/mirror` surface, mocked after `mockClientBoundaries`.
 *
 * The rating route is registered first: the list route is registered after it
 * and therefore answers first, so it must fall back for the rating path instead
 * of swallowing it. The stateful rating route stores the value it received, and
 * the list route then returns it, which is what the card's refetch reads.
 */
async function setupMirror(page: Page, state: MirrorState) {
  await mockClientBoundaries(page);

  await page.route('http://localhost:3000/**', async (route, request) => {
    const path = new URL(request.url()).pathname;
    const ratedId = request.method() === 'PATCH'
      ? path.match(/^\/vto\/generations\/([^/]+)\/rating$/)?.[1]
      : undefined;
    if (!ratedId) return route.fallback();
    const body = request.postDataJSON() as { rating: number };
    state.ratingRequests.push({ method: request.method(), path, body });
    const row = state.generations.find((generation) => generation.id === ratedId);
    if (row) row.rating = body.rating;
    return route.fulfill({ status: 204 });
  });

  await page.route('http://localhost:3000/**', async (route, request) => {
    if (request.method() !== 'GET') return route.fallback();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
    if (path === '/users/me') return json({ id: 'test-user-id', email: 'test@anywear.local', dailyCredits: 10 });
    if (path === '/wardrobe') return json([]);
    if (path === '/wardrobe/categories') return json({ categories: ['Top', 'Bottom'] });
    if (path === '/outfits') return json({ outfits: [] });
    if (path === '/vto/base-photos') return json([]);
    if (path === '/vto/generations') {
      return json({
        generations: state.generations,
        total: state.generations.length,
        page: 1,
        limit: 12,
        nextPage: null,
      });
    }
    return route.fallback();
  });
}

/** The actions overlay of the card at `index`, in list order. */
function rowOverlay(page: Page, index: number): Locator {
  return page.getByTestId('vto-history-actions').nth(index);
}

/** The card root of the card at `index`, found from its overlay so it survives a rating update. */
function rowCard(page: Page, index: number): Locator {
  return rowOverlay(page, index).locator(CARD_ROOT);
}

/** The media wrapper of the card at `index`. */
function rowMedia(page: Page, index: number): Locator {
  return page.getByTestId('vto-history-media').nth(index);
}

async function overlayOpacity(overlay: Locator): Promise<string> {
  return overlay.evaluate((element) => getComputedStyle(element).opacity);
}

interface HitResult {
  tag: string;
  overlay: boolean;
  radio: string | null;
}

/** What `document.elementFromPoint` resolves to at a viewport point. */
async function hitTest(page: Page, point: { x: number; y: number }): Promise<HitResult | null> {
  return page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    if (!element) return null;
    return {
      tag: element.tagName,
      overlay: element.closest('[data-testid="vto-history-actions"]') !== null,
      radio: element.closest('[role="radio"]')?.getAttribute('aria-label') ?? null,
    };
  }, point);
}

/** Asserts the pointer at the centre of the fourth star resolves to that star, never to the overlay. */
async function expectStarReceivesPointer(page: Page, card: Locator) {
  const star = card.getByRole('radio', { name: '4 stars' });
  const box = await star.boundingBox();
  expect(box, 'the fourth star has no layout box').not.toBeNull();
  const hit = await hitTest(page, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
  expect(hit, 'document.elementFromPoint returned no element at the star').not.toBeNull();
  expect(hit!.overlay, 'the actions overlay received the press').toBe(false);
  expect(hit!.radio, 'the fourth star received the press').toBe('4 stars');
}

test.describe('VTO history rating overlay (mocked Client integration)', () => {
  test.beforeEach(async ({ page }) => {
    await mockAmplifySession(page);
  });
  test.afterEach(({ page }) => expectOnlyMockedCalls(page));

  test('the fourth star receives the pointer while the actions are idle, hover-revealed and focus-revealed', async ({ page }) => {
    const state = createState();
    await setupMirror(page, state);
    await page.goto('/mirror');

    const card = rowCard(page, 0);
    const overlay = rowOverlay(page, 0);
    await expect(card.getByRole('radio', { name: '4 stars' })).toBeVisible();
    await card.evaluate((element) => element.scrollIntoView({ block: 'center' }));

    // Idle: the pointer is parked off the card, so nothing reveals the overlay.
    await page.mouse.move(1, 1);
    await expect.poll(() => overlayOpacity(overlay)).toBe('0');
    await expectStarReceivesPointer(page, card);

    // Pointer-hovered: the card's own hover reveals the actions over the media.
    await card.hover();
    await expect.poll(() => overlayOpacity(overlay)).toBe('1');
    await expectStarReceivesPointer(page, card);

    // Focus-revealed: an overlay action takes focus with the pointer parked away.
    await page.mouse.move(1, 1);
    await expect.poll(() => overlayOpacity(overlay)).toBe('0');
    await card.getByRole('button', { name: 'View Full', exact: true }).focus();
    await expect.poll(() => overlayOpacity(overlay)).toBe('1');
    await expectStarReceivesPointer(page, card);
  });

  test('an unforced click on the fourth star sends the rating and the card reads it back read-only', async ({ page }) => {
    const state = createState();
    await setupMirror(page, state);
    await page.goto('/mirror');

    const card = rowCard(page, 0);
    const star = card.getByRole('radio', { name: '4 stars' });
    await expect(star).toBeVisible();
    await star.click();

    await expect.poll(() => state.ratingRequests).toEqual([
      { method: 'PATCH', path: `/vto/generations/${UNRATED_ID}/rating`, body: { rating: 4 } },
    ]);
    await expect(card.getByText('Your rating: 4/5', { exact: true })).toBeVisible();
    await expect(card.getByRole('radio')).toHaveCount(0);
  });

  test('Enter and Space activate a star and send the same request as the pointer path', async ({ page }) => {
    const state = createState();
    await setupMirror(page, state);
    await page.goto('/mirror');

    const star = rowCard(page, 0).getByRole('radio', { name: '4 stars' });
    await expect(star).toBeVisible();
    await star.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => state.ratingRequests).toEqual([
      { method: 'PATCH', path: `/vto/generations/${UNRATED_ID}/rating`, body: { rating: 4 } },
    ]);

    // A fresh mount, so the row is unrated again for the Space case.
    state.generations = historyRows();
    state.ratingRequests = [];
    await page.reload();

    const reloadedStar = rowCard(page, 0).getByRole('radio', { name: '4 stars' });
    await expect(reloadedStar).toBeVisible();
    await reloadedStar.focus();
    await page.keyboard.press('Space');
    await expect.poll(() => state.ratingRequests).toEqual([
      { method: 'PATCH', path: `/vto/generations/${UNRATED_ID}/rating`, body: { rating: 4 } },
    ]);
  });

  for (const width of [390, 1440]) {
    test(`the action set fits inside the media box at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const state = createState();
      await setupMirror(page, state);
      await page.goto('/mirror');

      const expectedActions = [
        ['View Full', 'Reuse Outfit', 'Delete'],
        ['View Full', 'Reuse Outfit', 'Delete'],
        ['Reuse Outfit', 'Retry', 'Delete'],
      ];

      for (const index of [0, 1, 2]) {
        const overlay = rowOverlay(page, index);
        const media = rowMedia(page, index);
        await expect(overlay).toBeAttached();
        await expect(media).toBeAttached();

        const labels = (await overlay.locator('button').allTextContents()).map((label) => label.trim());
        expect(labels, `row ${index} actions`).toEqual(expectedActions[index]);
        expect(labels.length, `row ${index} never holds four actions`).toBeLessThan(4);

        const overlayBox = await overlay.boundingBox();
        const mediaBox = await media.boundingBox();
        expect(overlayBox, `row ${index} overlay has no layout box`).not.toBeNull();
        expect(mediaBox, `row ${index} media has no layout box`).not.toBeNull();
        for (const edge of ['x', 'y', 'width', 'height'] as const) {
          expect(overlayBox![edge], `row ${index} overlay ${edge} matches the media ${edge}`)
            .toBeCloseTo(mediaBox![edge], 2);
        }

        const lowest = await overlay.locator('button').last().boundingBox();
        expect(lowest, `row ${index} lowest action has no layout box`).not.toBeNull();
        expect(lowest!.y + lowest!.height, `row ${index} lowest action sits above the media box's bottom`)
          .toBeLessThan(mediaBox!.y + mediaBox!.height);
      }

      // The failed row renders no star, so its geometry is not an artefact of the
      // complete rows' rating control.
      await expect(rowMedia(page, 2).locator('[role="radio"]')).toHaveCount(0);
    });
  }

  test('records the pre-existing clipping of the star row below 390 px', async ({ page }) => {
    // A recorded condition, not a regression gate: the star row is wider than the
    // card body at 320 px before and after this change, and the guarantee this
    // delivery makes starts at the 390 px layout.
    await page.setViewportSize({ width: 320, height: 900 });
    const state = createState();
    await setupMirror(page, state);
    await page.goto('/mirror');

    const card = rowCard(page, 0);
    const fifthStar = card.getByRole('radio', { name: '5 stars' });
    await expect(fifthStar).toBeVisible();
    await card.evaluate((element) => element.scrollIntoView({ block: 'center' }));

    const starBox = await fifthStar.boundingBox();
    const cardBox = await card.boundingBox();
    expect(starBox, 'the fifth star has no layout box').not.toBeNull();
    expect(cardBox, 'the card has no layout box').not.toBeNull();
    expect(starBox!.x + starBox!.width, 'the fifth star extends past the card edge')
      .toBeGreaterThan(cardBox!.x + cardBox!.width);
  });

  test('a rated card exposes no star and sends no rating request when its read-only value is pressed', async ({ page }) => {
    const state = createState();
    await setupMirror(page, state);
    await page.goto('/mirror');

    const rated = page.getByText('Your rating: 4/5', { exact: true });
    await expect(rated).toBeVisible();
    const card = rated.locator(CARD_ROOT);
    await expect(card.getByRole('radio')).toHaveCount(0);
    await expect(card.locator('[role="radiogroup"]')).toHaveCount(0);

    await rated.click();
    // Give a request the press could have started time to reach the mock.
    await page.waitForTimeout(500);
    expect(state.ratingRequests).toEqual([]);
  });
});
