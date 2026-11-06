import { test, expect, type Page } from '@playwright/test';
import type { GetWardrobe200Item } from '../src/api/model/getWardrobe200Item';
import type { TaggingStatusResponse } from '../src/api/model/taggingStatusResponse';
import { mockClientBoundaries, expectOnlyMockedCalls } from './mock-boundaries';
import { mockAmplifySession } from './auth-session';

const ITEM_ID = '11111111-1111-1111-8111-111111111111';
const RESERVATION_ID = '22222222-2222-4222-8222-222222222222';
const IMAGE_ID = '33333333-3333-4333-8333-333333333333';
const mockItem: GetWardrobe200Item = {
  id: ITEM_ID, ownerId: 'test-user-id', name: 'My T-Shirt',
  images: [{ imageId: IMAGE_ID, url: 'https://example.com/test.jpg', view: null, isPrimary: true }],
  category: 'Top', taggingStatus: 'ready', weatherTags: ['Warm', 'Temperate'],
  styleAttributes: { color: 'Black', material: 'Cotton', design: 'Short-sleeve T-shirt', fit: 'Regular', pattern: 'Solid', neckline: 'Crew Neck', vibe: 'Casual' },
  isPublic: false, imageEmbedding: null,
  taggingStateVersion: 1, taggingErrorCode: null, taggingErrorMessage: null,
  createdAt: '2026-05-05T00:00:00.000Z', updatedAt: '2026-05-05T00:00:00.000Z',
};

/** The ready frame the aggregate stream sends for the item created by the upload. */
const readyFrame: TaggingStatusResponse = {
  item_id: ITEM_ID,
  tagging_status: 'ready',
  state_version: 2,
  style_attributes: { color: 'Black', material: 'Cotton' },
  weather_tags: ['Warm', 'Temperate'],
  error_message: null,
  images: [{ imageId: IMAGE_ID, url: 'https://example.com/test.jpg', view: null, isPrimary: true }],
};

interface MockState {
  items: GetWardrobe200Item[];
  mutations: Array<{ method: string; path: string; body: unknown }>;
  categories: Array<string | null>;
  uploadedForm?: string;
  /** Holds the aggregate stream response until the test releases a frame. */
  streamGate?: Promise<void>;
  /** Frames the aggregate stream answers with. */
  streamFrames: TaggingStatusResponse[];
  streamRequests: number;
}

function emptyState(): MockState {
  return { items: [], mutations: [], categories: [], streamFrames: [], streamRequests: 0 };
}

function stateWithItem(item = structuredClone(mockItem)): MockState {
  return { ...emptyState(), items: [item] };
}

async function setupMock(page: Page, state: MockState) {
  await mockClientBoundaries(page);
  // The signed policy's target. The browser posts the policy fields and the file
  // in one multipart body; the form's text carries the signed fields and the file
  // part header, which is what proves the policy was honoured.
  await page.route('https://s3.example.com/upload', async (route, request) => {
    state.uploadedForm = request.postData() ?? undefined;
    state.mutations.push({ method: request.method(), path: '/upload',
      body: { contentType: request.headers()['content-type']?.split(';')[0] } });
    return route.fulfill({ status: 204 });
  });
  await page.route('http://localhost:3000/**', async (route, request) => {
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (method === 'GET' && path === '/users/me') return json({ id: 'test-user-id', email: 'test@anywear.local' });
    if (method === 'GET' && path === '/outfits') return json({ outfits: [] });
    if (method === 'GET' && path === '/wardrobe/categories') return json({ categories: ['Top', 'Bottom'] });
    if (method === 'GET' && path === '/wardrobe') {
      const category = url.searchParams.get('category');
      state.categories.push(category);
      return json(state.items.filter(item => !category || item.category === category));
    }
    // One caller-scoped aggregate stream replaces the per-item streams. A test
    // that needs a live transition holds the response and releases a frame.
    if (method === 'GET' && path === '/wardrobe/status/stream') {
      state.streamRequests += 1;
      if (state.streamGate) await state.streamGate;
      const body = state.streamFrames
        .map((frame) => `event: status\ndata: ${JSON.stringify(frame)}\n\n`)
        .join('');
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body }).catch(() => undefined);
    }
    if (method === 'POST' && path === '/wardrobe/upload-url') {
      state.mutations.push({ method, path, body: request.postDataJSON() });
      // A reservation, not an item: the item does not exist until the
      // confirmation has verified the stored object.
      return json({ reservationId: RESERVATION_ID,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        upload: { url: 'https://s3.example.com/upload', fields: { key: `wearable-items/test-user-id/${RESERVATION_ID}.png`,
          'Content-Type': 'image/png', policy: 'signed-policy', 'x-amz-signature': 'signature' } } });
    }
    if (method === 'POST' && path === '/wardrobe/upload') {
      state.mutations.push({ method, path, body: request.postDataJSON() });
      state.items = [{ ...structuredClone(mockItem), taggingStatus: 'processing' }];
      return json({ itemId: ITEM_ID, taggingStatus: 'processing' }, 202);
    }
    if (method === 'PATCH' && path === `/wardrobe/items/${ITEM_ID}`) {
      const body = request.postDataJSON();
      state.mutations.push({ method, path, body });
      const item = state.items.find(item => item.id === ITEM_ID);
      if (!item) return json({ error: 'NOT_FOUND' }, 404);
      Object.assign(item, body);
      return json(item);
    }
    if (method === 'POST' && path === `/wardrobe/items/${ITEM_ID}/retag`) {
      state.mutations.push({ method, path, body: request.postData() ? request.postDataJSON() : undefined });
      state.items = state.items.map(item => ({ ...item, taggingStatus: 'processing' }));
      return json({ itemId: ITEM_ID, taggingStatus: 'processing' }, 202);
    }
    return route.fallback();
  });
}

test.describe('Wardrobe Auto-Tagging (mocked Client integration)', () => {
  test.beforeEach(async ({ page }) => {
    await mockAmplifySession(page);
  });
  test.afterEach(({ page }) => expectOnlyMockedCalls(page));

  test('uploads an image, shows processing and reaches ready on the status stream without reload', async ({ page }) => {
    const state = emptyState();
    let releaseStream!: () => void;
    state.streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    state.streamFrames = [readyFrame];
    await setupMock(page, state);
    await page.goto('/wardrobe');
    await expect(page.getByText('Your wardrobe is empty.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Add Item', exact: true }).click();
    await page.locator('#add-item-image').setInputFiles('browser/fixtures/dummy.png');
    await page.getByRole('button', { name: 'Upload & Auto-Tag', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Add Wardrobe Item' })).not.toBeVisible();
    await expect(page.getByText('My T-Shirt', { exact: true })).toBeVisible();
    await expect(page.getByText('Analyzing...', { exact: true })).toBeVisible();
    expect(state.mutations).toEqual([
      { method: 'POST', path: '/wardrobe/upload-url', body: { contentType: 'image/png' } },
      { method: 'POST', path: '/upload', body: { contentType: 'multipart/form-data' } },
      { method: 'POST', path: '/wardrobe/upload', body: { reservationId: RESERVATION_ID } },
    ]);
    const uploadedForm = state.uploadedForm;
    // The signed policy fields must be sent verbatim and the file part last;
    // S3 rejects the form otherwise, and the browser cannot relax a condition.
    expect(uploadedForm).toContain('signed-policy');
    expect(uploadedForm).toContain('x-amz-signature');
    expect(uploadedForm).toContain('name="file"; filename="dummy.png"');
    expect(uploadedForm?.trimEnd().endsWith('--')).toBe(true);

    // The page holds one aggregate stream while the item is in flight. The frame
    // arrives on that stream: no list interval and no reload is involved.
    await expect.poll(() => state.streamRequests).toBeGreaterThan(0);
    const requestsBeforeRelease = state.streamRequests;
    state.items[0] = { ...structuredClone(mockItem), taggingStatus: 'ready', taggingStateVersion: 2 };
    releaseStream();
    await expect(page.getByText('Analyzing...', { exact: true })).not.toBeVisible();
    await expect(page.getByText('Black • Cotton', { exact: true })).toBeVisible();
    expect(state.streamRequests).toBeGreaterThanOrEqual(requestsBeforeRelease);
    await expect(page.getByText('My T-Shirt', { exact: true })).toBeVisible();
  });

  test('adds three photos in one action, keeps one failure in its row and retries only that row', async ({ page }) => {
    const state = emptyState();
    await setupMock(page, state);

    // Distinct file names: the duplicate collapse is by name, size and lastModified.
    const fileNames = ['batch-one.png', 'batch-two.png', 'batch-three.png'];
    const reservationIds: string[] = [];
    const postedFiles: string[] = [];
    const confirmedReservations: string[] = [];
    const fileByReservation = new Map<string, string>();
    const itemByFile = new Map<string, string>();
    let rejectedBatchTwo = false;

    await page.route('http://localhost:3000/wardrobe/upload-url', async (route) => {
      const reservationId = `batch-reservation-${reservationIds.length + 1}`;
      reservationIds.push(reservationId);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          reservationId,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          upload: {
            url: 'https://s3.example.com/upload',
            fields: {
              key: `wearable-items/test-user-id/${reservationId}.png`,
              'Content-Type': 'image/png',
              policy: 'signed-policy',
              'x-amz-signature': 'signature',
            },
          },
        }),
      });
    });

    await page.route('https://s3.example.com/upload', async (route, request) => {
      const body = request.postData() ?? '';
      const key = /name="key"\r?\n\r?\n([^\r\n]+)/.exec(body)?.[1] ?? '';
      const fileName = /name="file"; filename="([^"]+)"/.exec(body)?.[1] ?? '';
      const reservationId = key.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
      fileByReservation.set(reservationId, fileName);
      postedFiles.push(fileName);
      // The signed policy authorizes one object; S3 refuses the body it is told to.
      if (fileName === 'batch-two.png' && !rejectedBatchTwo) {
        rejectedBatchTwo = true;
        return route.fulfill({ status: 403 });
      }
      return route.fulfill({ status: 204 });
    });

    await page.route('http://localhost:3000/wardrobe/upload', async (route, request) => {
      const { reservationId } = request.postDataJSON() as { reservationId: string };
      confirmedReservations.push(reservationId);
      const fileName = fileByReservation.get(reservationId) ?? 'unknown.png';
      let itemId = itemByFile.get(fileName);
      if (!itemId) {
        itemId = `item-${itemByFile.size + 1}`;
        itemByFile.set(fileName, itemId);
        // A confirmation creates the item; the retry's fresh reservation replays it
        // rather than creating a fourth.
        state.items.push({
          ...structuredClone(mockItem),
          id: itemId,
          name: `Item ${fileName}`,
          taggingStatus: 'ready',
          styleAttributes: {},
        });
      }
      return route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ itemId, taggingStatus: 'ready' }),
      });
    });

    await page.goto('/wardrobe');
    await expect(page.getByText('Your wardrobe is empty.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Add Item', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: 'Add Wardrobe Item' });
    await page.locator('#add-item-image').setInputFiles(
      fileNames.map((name) => ({ name, mimeType: 'image/png', buffer: Buffer.from('png') })),
    );
    await expect(dialog.getByRole('listitem')).toHaveCount(3);
    await page.getByRole('button', { name: 'Add 3 items', exact: true }).click();

    // Two photos became items; the rejected S3 post fails only its own row.
    await expect(dialog.getByRole('listitem').filter({ hasText: 'Created' })).toHaveCount(2);
    const failedRow = dialog.getByRole('listitem').filter({ hasText: 'Failed' });
    await expect(failedRow).toHaveCount(1);
    await expect(failedRow).toContainText('batch-two.png');
    await expect(failedRow).toContainText('Image upload failed with HTTP 403');
    await expect(dialog.getByText('2 items added, 1 failed')).toBeVisible();

    // Each photo reserves and posts on its own; the rejected body fails that photo
    // before its confirmation, so the first round confirms only the two that landed.
    expect(reservationIds).toHaveLength(3);
    expect(postedFiles).toHaveLength(3);
    expect(confirmedReservations).toHaveLength(2);
    expect(state.items).toHaveLength(2);

    await dialog.getByRole('button', { name: 'Retry failed', exact: true }).click();

    await expect(dialog.getByText('3 items added, 0 failed')).toBeVisible();
    await expect(dialog.getByRole('listitem').filter({ hasText: 'Created' })).toHaveCount(3);
    // Retry ran the one failed row: a fresh reservation, one post, one confirmation,
    // and the same item, so the wardrobe ends with three items and no fourth.
    expect(reservationIds).toHaveLength(4);
    expect(postedFiles.slice(3)).toEqual(['batch-two.png']);
    expect(confirmedReservations).toHaveLength(3);
    expect(state.items).toHaveLength(3);
    await expect(page.getByText('Item batch-one.png', { exact: true })).toBeVisible();
  });

  test('populates auto-tagged values, saves edits and refreshes the item', async ({ page }) => {
    const state = stateWithItem();
    await setupMock(page, state);
    await page.goto('/wardrobe');
    await page.getByText('My T-Shirt', { exact: true }).click();
    await expect(page.getByPlaceholder('e.g. My favorite hoodie')).toHaveValue('My T-Shirt');
    await expect(page.getByPlaceholder('e.g. Top', { exact: true })).toHaveValue('Top');
    await expect(page.getByPlaceholder('e.g. Black, White')).toHaveValue('Black');
    await expect(page.getByPlaceholder('e.g. Cotton', { exact: true })).toHaveValue('Cotton');
    await expect(page.getByPlaceholder('e.g. Cold, Windy, Warm')).toHaveValue('Warm, Temperate');
    await page.getByPlaceholder('e.g. My favorite hoodie').fill('My Favorite Hoodie');
    await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Item Details' })).not.toBeVisible();
    await expect(page.getByText('My Favorite Hoodie', { exact: true })).toBeVisible();
    expect(state.mutations).toEqual([{ method: 'PATCH', path: `/wardrobe/items/${ITEM_ID}`, body: {
      name: 'My Favorite Hoodie', category: 'Top', images: [{ imageId: IMAGE_ID, isPrimary: true }],
      styleAttributes: mockItem.styleAttributes, weatherTags: ['Warm', 'Temperate'],
    } }]);
  });

  test('requests re-tagging and refreshes the processing badge', async ({ page }) => {
    const state = stateWithItem();
    await setupMock(page, state);
    await page.goto('/wardrobe');
    await page.getByText('My T-Shirt', { exact: true }).click();
    const retagButton = page.getByRole('button', { name: 'Re-tag', exact: true });
    await expect(retagButton).toBeEnabled();
    const messages: string[] = [];
    page.on('dialog', async dialog => { messages.push(dialog.message()); await dialog.accept(); });
    await retagButton.click();
    await expect(page.getByRole('heading', { name: 'Item Details' })).not.toBeVisible();
    await expect(page.getByText('Analyzing...', { exact: true })).toBeVisible();
    expect(messages).toEqual(['Re-tagging started. Check back shortly.']);
    expect(state.mutations).toEqual([{ method: 'POST', path: `/wardrobe/items/${ITEM_ID}/retag`, body: undefined }]);
  });

  test('filters by the category query and restores all items', async ({ page }) => {
    const state = stateWithItem();
    state.items.push({ ...structuredClone(mockItem), id: '22222222-2222-4222-8222-222222222222', name: 'My Jeans', category: 'Bottom' });
    await setupMock(page, state);
    await page.goto('/wardrobe');
    await expect(page.getByText('My T-Shirt', { exact: true })).toBeVisible();
    await expect(page.getByText('My Jeans', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Top', exact: true }).click();
    await expect(page.getByText('My T-Shirt', { exact: true })).toBeVisible();
    await expect(page.getByText('My Jeans', { exact: true })).not.toBeVisible();
    expect(state.categories).toContain('Top');
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(page.getByText('My Jeans', { exact: true })).toBeVisible();
  });

  test('shows the failed badge and opens failed item details', async ({ page }) => {
    const state = stateWithItem({ ...structuredClone(mockItem), name: 'Bad Upload', taggingStatus: 'failed', styleAttributes: {} });
    await setupMock(page, state);
    await page.goto('/wardrobe');
    await expect(page.getByText('Failed', { exact: true })).toBeVisible();
    await page.getByText('Bad Upload', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Item Details' })).toBeVisible();
    await expect(page.getByText('Tagging Failed', { exact: true })).toBeVisible();
  });
});
