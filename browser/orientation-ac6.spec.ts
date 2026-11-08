import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import type { GetWardrobe200Item } from '../src/api/model/getWardrobe200Item';
import type { GetVtoBasePhotos200Item } from '../src/api/model/getVtoBasePhotos200Item';
import type { PostVtoBasePhotosUpload201 } from '../src/api/model/postVtoBasePhotosUpload201';
import { mockClientBoundaries, expectOnlyMockedCalls } from './mock-boundaries';
import { mockAmplifySession } from './auth-session';

/**
 * AC-6: a photo with EXIF Orientation 6 that arrives through a camera entry must
 * reach the wardrobe card and The Mirror's base-photo surface upright, with the
 * orientation baked into the pixels and no EXIF orientation left in the bytes.
 *
 * The fixture is built by `browser/fixtures/build-orientation6-jpeg.mjs`: a real
 * baseline JPEG whose stored frame is 40x20, whose EXIF Orientation tag is 6, and
 * whose stored pixels hold two horizontal bands - the top 8 rows light (level
 * 200), the rest dark (level 100). A viewer that honours the tag shows it as
 * 20x40 with the light band on the right, so the rotation is observable both in
 * the dimensions and in the pixels.
 *
 * Everything under test is real: the fixture goes through `setInputFiles` into
 * the camera input, Chromium's own `createImageBitmap`/`canvas.toBlob` run
 * `prepareImageForUpload`, and the bytes the test inspects are the ones the
 * browser actually posted to the signed S3 policy. Only the network is mocked.
 */

const FIXTURE_PATH = 'browser/fixtures/orientation6.jpg';
const fixtureBytes = readFileSync(FIXTURE_PATH);
/** The frame the JPEG stores. */
const STORED = { width: 40, height: 20 };
/** The frame a viewer shows after applying Orientation 6. */
const UPRIGHT = { width: 20, height: 40 };
const FIXTURE_FILE = { name: 'IMG_0006.jpg', mimeType: 'image/jpeg', buffer: fixtureBytes };

const WARDROBE_ITEM_ID = '44444444-4444-4444-8444-444444444444';
const BASE_PHOTO_ID = '55555555-5555-4555-8555-555555555555';

interface Surface {
  /** The reservation the Client asks for before it posts anything. */
  reservationPath: string;
  /** The confirmation that turns the posted object into an item or photo. */
  confirmPath: string;
  /** The signed policy target the browser posts the prepared file to. */
  uploadUrl: string;
  /** The URL the created item or photo reports, served with the posted bytes. */
  artifactUrl: string;
}

const WARDROBE: Surface = {
  reservationPath: '/wardrobe/upload-url',
  confirmPath: '/wardrobe/upload',
  uploadUrl: 'https://s3.example.com/wardrobe-camera',
  artifactUrl: 'https://example.com/artifact/wardrobe-camera.jpg',
};

const BASE_PHOTO: Surface = {
  reservationPath: '/vto/base-photos/upload-url',
  confirmPath: '/vto/base-photos/upload',
  uploadUrl: 'https://s3.example.com/base-photo-camera',
  artifactUrl: 'https://example.com/artifact/base-photo-camera.jpg',
};

// ---------------------------------------------------------------------------
// JPEG byte inspection. The test parses the posted bytes itself instead of
// trusting the decoder under test: the frame it reports and the APP1 segments it
// finds are the evidence.
// ---------------------------------------------------------------------------

interface JpegSegment {
  marker: number;
  payload: Buffer;
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** The JPEG's marker segments up to the start of scan, in file order. */
function jpegSegments(bytes: Buffer): JpegSegment[] {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('not a JPEG: missing the SOI marker');
  }
  const segments: JpegSegment[] = [];
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error(`not a JPEG: expected a marker at byte ${offset}`);
    let marker = bytes[offset + 1];
    // A run of 0xFF bytes is legal fill before the marker code.
    while (marker === 0xff && offset + 4 <= bytes.length) {
      offset += 1;
      marker = bytes[offset + 1];
    }
    const length = bytes.readUInt16BE(offset + 2);
    const payload = bytes.subarray(offset + 4, offset + 2 + length);
    segments.push({ marker, payload });
    // The entropy-coded scan data follows SOS, not a length-prefixed segment.
    if (marker === 0xda) break;
    offset += 2 + length;
  }
  return segments;
}

/** The frame the JPEG stores, read from its start-of-frame segment. */
function jpegFrameSize(bytes: Buffer): { width: number; height: number } {
  const frame = jpegSegments(bytes).find((segment) => SOF_MARKERS.has(segment.marker));
  if (!frame) throw new Error('not a JPEG: no start-of-frame segment');
  return { height: frame.payload.readUInt16BE(1), width: frame.payload.readUInt16BE(3) };
}

/**
 * The EXIF orientation the bytes declare, plus how many APP1 segments they carry.
 * `orientation: null` with `app1Count: 0` is "no EXIF direction at all"; a tag
 * that is present but not an orientation reads as `orientation: null` too, so the
 * count is what tells the two apart.
 */
function jpegExifOrientation(bytes: Buffer): { orientation: number | null; app1Count: number } {
  const app1 = jpegSegments(bytes).filter((segment) => segment.marker === 0xe1);
  const exif = app1.find((segment) => segment.payload.subarray(0, 4).toString('latin1') === 'Exif');
  if (!exif) return { orientation: null, app1Count: app1.length };

  const tiff = exif.payload.subarray(6);
  const littleEndian = tiff.toString('latin1', 0, 2) === 'II';
  const read16 = (offset: number) => (littleEndian ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset));
  const read32 = (offset: number) => (littleEndian ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset));
  if (read16(2) !== 0x2a) return { orientation: null, app1Count: app1.length };

  const ifd = read32(4);
  const entries = read16(ifd);
  for (let index = 0; index < entries; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (read16(entry) !== 0x0112) continue;
    const type = read16(entry + 2);
    if (read32(entry + 4) !== 1) return { orientation: null, app1Count: app1.length };
    if (type === 3) return { orientation: read16(entry + 8), app1Count: app1.length };
    if (type === 4) return { orientation: read32(entry + 8), app1Count: app1.length };
    return { orientation: null, app1Count: app1.length };
  }
  return { orientation: null, app1Count: app1.length };
}

// ---------------------------------------------------------------------------
// The multipart body the browser posted to the signed policy, split into parts.
// ---------------------------------------------------------------------------

interface PostedPart {
  name: string;
  contentType: string | null;
  bytes: Buffer;
}

function multipartParts(body: Buffer, contentType: string): PostedPart[] {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!boundaryMatch) throw new Error(`no multipart boundary in "${contentType}"`);
  const delimiter = Buffer.from(`--${boundaryMatch[1] ?? boundaryMatch[2]}`);
  const parts: PostedPart[] = [];
  let cursor = body.indexOf(delimiter);
  while (cursor >= 0) {
    let start = cursor + delimiter.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    if (body.subarray(start, start + 2).toString() !== '\r\n') throw new Error('malformed multipart boundary');
    start += 2;
    const headerEnd = body.indexOf('\r\n\r\n', start);
    if (headerEnd < 0) throw new Error('malformed multipart part headers');
    const headers = body.subarray(start, headerEnd).toString('utf8');
    const contentStart = headerEnd + 4;
    const next = body.indexOf(delimiter, contentStart);
    if (next < 0) throw new Error('unterminated multipart part');
    // The CRLF before the next delimiter terminates the part; it is not content.
    parts.push({
      name: /name="([^"]*)"/i.exec(headers)?.[1] ?? '',
      contentType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? null,
      bytes: body.subarray(contentStart, next - 2),
    });
    cursor = next;
  }
  return parts;
}

// ---------------------------------------------------------------------------
// The real page decoder, asked the same way `prepareImageForUpload` asks it.
// ---------------------------------------------------------------------------

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface DecodedJpeg {
  width: number;
  height: number;
  /** The middle row's pixel well inside the left band and well inside the right one. */
  left: Rgb;
  right: Rgb;
}

async function decodeJpeg(page: Page, bytes: Buffer): Promise<DecodedJpeg> {
  return page.evaluate(async (base64) => {
    const binary = atob(base64);
    const data = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) data[index] = binary.charCodeAt(index);
    const bitmap = await createImageBitmap(
      new Blob([data], { type: 'image/jpeg' }),
      { imageOrientation: 'from-image' },
    );
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('the page has no 2d canvas context');
      context.drawImage(bitmap, 0, 0);
      const pixel = (x: number, y: number) => {
        const [r, g, b] = context.getImageData(x, y, 1, 1).data;
        return { r, g, b };
      };
      const middle = Math.floor(bitmap.height / 2);
      return {
        width: bitmap.width,
        height: bitmap.height,
        left: pixel(3, middle),
        right: pixel(bitmap.width - 4, middle),
      };
    } finally {
      bitmap.close();
    }
  }, bytes.toString('base64'));
}

// ---------------------------------------------------------------------------
// Mocked boundary: the Service responses and the signed policy's target. The
// decoder and encoder are never touched.
// ---------------------------------------------------------------------------

interface MockState {
  wardrobe: GetWardrobe200Item[];
  basePhotos: GetVtoBasePhotos200Item[];
  /** The `file` part of the multipart body each surface posted. */
  posted: Map<string, PostedPart>;
  /** The reservation bodies, in call order. */
  reserved: Array<{ path: string; body: unknown }>;
  /** The bytes each artifact URL served, keyed by URL. */
  served: Map<string, Buffer>;
}

function createState(): MockState {
  return { wardrobe: [], basePhotos: [], posted: new Map(), reserved: [], served: new Map() };
}

function requirePosted(state: MockState, surface: Surface): PostedPart {
  const part = state.posted.get(surface.uploadUrl);
  if (!part) throw new Error(`the browser never posted a file to ${surface.uploadUrl}`);
  return part;
}

function wardrobeItem(url: string): GetWardrobe200Item {
  return {
    id: WARDROBE_ITEM_ID,
    ownerId: 'test-user-id',
    name: 'Orientation Tee',
    category: 'Top',
    images: [{ imageId: 'image-wardrobe-camera', url, view: null, isPrimary: true }],
    taggingStatus: 'ready',
    weatherTags: [],
    styleAttributes: {},
    isPublic: false,
    imageEmbedding: null,
    taggingStateVersion: 1,
    taggingErrorCode: null,
    taggingErrorMessage: null,
    createdAt: '2026-11-08T00:00:00.000Z',
    updatedAt: '2026-11-08T00:00:00.000Z',
  };
}

function basePhoto(url: string): GetVtoBasePhotos200Item {
  return {
    id: BASE_PHOTO_ID,
    userId: 'test-user-id',
    imageId: 'image-base-photo-camera',
    url,
    isDefault: false,
    source: 'user',
    createdAt: '2026-11-08T00:00:00.000Z',
  };
}

async function setupMock(page: Page, state: MockState) {
  await mockClientBoundaries(page);

  // The signed policy target: the browser's own multipart body is captured whole,
  // so the assertion sees the exact bytes the upload sent.
  for (const surface of [WARDROBE, BASE_PHOTO]) {
    await page.route(surface.uploadUrl, async (route, request) => {
      const contentType = request.headers()['content-type'] ?? '';
      const parts = multipartParts(request.postDataBuffer() ?? Buffer.alloc(0), contentType);
      const file = parts.find((part) => part.name === 'file');
      if (!file) throw new Error(`the post to ${surface.uploadUrl} carried no file part`);
      state.posted.set(surface.uploadUrl, file);
      return route.fulfill({ status: 204 });
    });
  }

  // The created item and photo report an image URL; those URLs answer with the
  // bytes the browser posted, so the card renders the artifact the test inspects.
  await page.route('https://example.com/artifact/**', async (route, request) => {
    const bytes = state.served.get(request.url());
    if (!bytes) return route.fulfill({ status: 404 });
    return route.fulfill({ status: 200, contentType: 'image/jpeg', body: bytes });
  });

  await page.route('http://localhost:3000/**', async (route, request) => {
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(body),
    });

    if (method === 'GET' && path === '/users/me') {
      return json({ id: 'test-user-id', email: 'test@anywear.local', dailyCredits: 10 });
    }
    if (method === 'GET' && path === '/wardrobe') return json(state.wardrobe);
    if (method === 'GET' && path === '/wardrobe/categories') return json({ categories: [] });
    if (method === 'GET' && path === '/outfits') return json({ outfits: [] });
    if (method === 'GET' && path === '/vto/base-photos') return json(state.basePhotos);
    if (method === 'GET' && path === '/vto/generations') {
      return json({ generations: [], total: 0, page: 1, limit: 12, nextPage: null });
    }

    if (method === 'POST' && path === WARDROBE.reservationPath) {
      state.reserved.push({ path, body: request.postDataJSON() });
      return json({
        reservationId: 'reservation-wardrobe-camera',
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        upload: {
          url: WARDROBE.uploadUrl,
          fields: { key: 'wardrobe-camera.jpg', 'Content-Type': 'image/jpeg', policy: 'signed-policy', 'x-amz-signature': 'signature' },
        },
      });
    }
    if (method === 'POST' && path === WARDROBE.confirmPath) {
      state.served.set(WARDROBE.artifactUrl, requirePosted(state, WARDROBE).bytes);
      state.wardrobe = [wardrobeItem(WARDROBE.artifactUrl)];
      return json({ itemId: WARDROBE_ITEM_ID, taggingStatus: 'ready' });
    }

    if (method === 'POST' && path === BASE_PHOTO.reservationPath) {
      state.reserved.push({ path, body: request.postDataJSON() });
      return json({
        reservationId: 'reservation-base-photo-camera',
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        upload: {
          url: BASE_PHOTO.uploadUrl,
          fields: { key: 'base-photo-camera.jpg', 'Content-Type': 'image/jpeg', policy: 'signed-policy', 'x-amz-signature': 'signature' },
        },
      });
    }
    if (method === 'POST' && path === BASE_PHOTO.confirmPath) {
      const photo: PostVtoBasePhotosUpload201 = {
        ...basePhoto(BASE_PHOTO.artifactUrl),
        id: BASE_PHOTO_ID,
      };
      state.served.set(BASE_PHOTO.artifactUrl, requirePosted(state, BASE_PHOTO).bytes);
      state.basePhotos = [photo];
      return json(photo, 201);
    }

    return route.fallback();
  });
}

/**
 * The fixture's own construction: the stored frame is landscape, its EXIF says
 * Orientation 6, and the real page decoder therefore shows a portrait frame whose
 * light band is on the right. That is the "before" the upload must reproduce.
 */
async function expectFixtureIsOrientation6(page: Page): Promise<DecodedJpeg> {
  expect(jpegFrameSize(fixtureBytes)).toEqual(STORED);
  expect(jpegExifOrientation(fixtureBytes)).toEqual({ orientation: 6, app1Count: 1 });
  // Orientation 6 is a transposition: the upright frame is the stored one turned.
  expect({ width: STORED.height, height: STORED.width }).toEqual(UPRIGHT);

  const decoded = await decodeJpeg(page, fixtureBytes);
  expect({ width: decoded.width, height: decoded.height }).toEqual(UPRIGHT);
  expect(decoded.left.r).toBeLessThan(150);
  expect(decoded.right.r).toBeGreaterThan(150);
  return decoded;
}

/** The artifact the upload produced: upright pixels, no EXIF direction at all. */
async function expectBakedArtifact(page: Page, posted: PostedPart, upright: DecodedJpeg): Promise<void> {
  expect(posted.contentType).toBe('image/jpeg');
  expect(posted.bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

  // The stored frame is the upright one, not the fixture's 40x20: the rotation is
  // in the pixels, so the aspect ratio has flipped rather than been re-declared
  // through metadata.
  expect(jpegFrameSize(posted.bytes)).toEqual(UPRIGHT);

  // No EXIF direction survives: the re-encoded JPEG carries no APP1 segment at
  // all, so there is no orientation tag a later viewer could apply again.
  expect(jpegExifOrientation(posted.bytes)).toEqual({ orientation: null, app1Count: 0 });

  // And the pixels landed where the real decoder put the fixture's upright view:
  // dark on the left, light on the right, at the photographed levels.
  const decoded = await decodeJpeg(page, posted.bytes);
  expect({ width: decoded.width, height: decoded.height }).toEqual(UPRIGHT);
  expect(decoded.left.r).toBeLessThan(150);
  expect(decoded.right.r).toBeGreaterThan(150);
  expect(Math.abs(decoded.left.r - upright.left.r)).toBeLessThanOrEqual(20);
  expect(Math.abs(decoded.right.r - upright.right.r)).toBeLessThanOrEqual(20);
}

test.describe('AC-6 EXIF orientation through the camera entry', () => {
  test.beforeEach(async ({ page }) => {
    await mockAmplifySession(page);
  });

  test.afterEach(({ page }) => expectOnlyMockedCalls(page));

  test('the wardrobe camera entry posts upright, EXIF-free pixels and the card renders them upright', async ({ page }) => {
    const state = createState();
    await setupMock(page, state);
    await page.goto('/wardrobe');
    await expect(page.getByText('Your wardrobe is empty.', { exact: false })).toBeVisible();

    const upright = await expectFixtureIsOrientation6(page);

    // The camera entry, not the library one: `accept="image/*"` plus
    // `capture="environment"` is the branch the native shell sends to the camera.
    await page.getByRole('button', { name: 'Add Item', exact: true }).click();
    await page.locator('#add-item-camera').setInputFiles(FIXTURE_FILE);
    await page.getByRole('button', { name: 'Upload & Auto-Tag', exact: true }).click();

    // One photo keeps the single-photo contract: success closes the dialog and the
    // refetched wardrobe renders the card.
    await expect(page.getByRole('heading', { name: 'Add Wardrobe Item' })).not.toBeVisible();
    const card = page.getByRole('button', { name: 'View Orientation Tee details' });
    await expect(card).toBeVisible();

    // The reservation declared the prepared JPEG, before any bytes were sent.
    expect(state.reserved).toEqual([{ path: WARDROBE.reservationPath, body: { contentType: 'image/jpeg' } }]);

    const posted = requirePosted(state, WARDROBE);
    await expectBakedArtifact(page, posted, upright);

    // The artifact URL serves the bytes the browser posted, so the dimensions
    // below describe that artifact, not a re-encoded copy: the card cannot be
    // upright by a second EXIF application because the served bytes carry none.
    expect(state.served.get(WARDROBE.artifactUrl)?.equals(posted.bytes)).toBe(true);
    const image = card.locator('img');
    await expect(image).toHaveAttribute('src', WARDROBE.artifactUrl);
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => ({
        width: element.naturalWidth, height: element.naturalHeight,
      })))
      .toEqual(UPRIGHT);
  });

  test('the Mirror camera entry posts the same upright, EXIF-free artifact as the base photo', async ({ page }) => {
    const state = createState();
    await setupMock(page, state);
    await page.goto('/mirror');
    await expect(page.getByRole('heading', { name: 'Choose a base photo' })).toBeVisible();

    const upright = await expectFixtureIsOrientation6(page);

    // The Mirror's camera entry. A base photo is the only client-side image the
    // try-on generation is derived from; the generated result itself is a Service
    // artifact this client never re-encodes, so the base photo is what AC-6's
    // client half can prove.
    await page.locator('input[type="file"][capture="environment"]').setInputFiles(FIXTURE_FILE);

    // The confirmation adopts the photo as the effective base photo: the card is
    // selected, so a try-on request would be built from this artifact.
    const card = page.getByRole('button', { name: 'Selected base photo 1' });
    await expect(card).toBeVisible();

    expect(state.reserved).toEqual([{ path: BASE_PHOTO.reservationPath, body: { contentType: 'image/jpeg' } }]);

    const posted = requirePosted(state, BASE_PHOTO);
    await expectBakedArtifact(page, posted, upright);

    expect(state.served.get(BASE_PHOTO.artifactUrl)?.equals(posted.bytes)).toBe(true);
    const image = card.locator('img');
    await expect(image).toHaveAttribute('src', BASE_PHOTO.artifactUrl);
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => ({
        width: element.naturalWidth, height: element.naturalHeight,
      })))
      .toEqual(UPRIGHT);
  });
});
