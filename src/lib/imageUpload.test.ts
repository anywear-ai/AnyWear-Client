import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HEIC_UNSUPPORTED_MESSAGE,
  resolveImageContentType,
  uploadImageWithSignedPost,
  validateImageFile,
} from './imageUpload';

const upload = {
  url: 'https://bucket.s3.us-east-1.amazonaws.com/',
  fields: {
    key: 'wearable-items/user-1/res-1.jpg',
    'Content-Type': 'image/jpeg',
    policy: 'signed-policy',
    'x-amz-signature': 'signature',
  },
};

describe('imageUpload', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects non-image and oversized files before upload', () => {
    expect(() => validateImageFile(new File(['text'], 'notes.txt', { type: 'text/plain' })))
      .toThrow('Select an image file');

    const oversized = new File([new Uint8Array(30 * 1024 * 1024 + 1)], 'large.jpg', {
      type: 'image/jpeg',
    });
    expect(() => validateImageFile(oversized)).toThrow('Image must be 30MB or smaller');
  });

  it('admits a 10–30 MiB original so preparation can shrink it', () => {
    const cameraOriginal = new File([new Uint8Array(20 * 1024 * 1024)], 'IMG_0001.jpg', {
      type: 'image/jpeg',
    });

    expect(() => validateImageFile(cameraOriginal)).not.toThrow();
  });

  it('rejects HEIC/HEIF by filename when the browser omits the MIME type', () => {
    expect(() => validateImageFile(new File(['image'], 'camera.heic')))
      .toThrow(HEIC_UNSUPPORTED_MESSAGE);
    expect(() => validateImageFile(new File(['image'], 'camera.heif')))
      .toThrow(HEIC_UNSUPPORTED_MESSAGE);
    expect(() => validateImageFile(new File(['image'], 'CAMERA.HEIC')))
      .toThrow(HEIC_UNSUPPORTED_MESSAGE);

    // The format is named before the size, so an oversized HEIC tells the user
    // to re-encode rather than to shrink a file that would fail anyway.
    const oversized = new File([new Uint8Array(30 * 1024 * 1024 + 1)], 'camera.heic');
    expect(() => validateImageFile(oversized)).toThrow(HEIC_UNSUPPORTED_MESSAGE);
  });

  it('rejects HEIC/HEIF by MIME type even when the filename looks accepted', () => {
    expect(() => validateImageFile(new File(['image'], 'photo.jpg', { type: 'image/heic' })))
      .toThrow(HEIC_UNSUPPORTED_MESSAGE);
    expect(() => validateImageFile(new File(['image'], 'photo.jpg', { type: 'image/heif' })))
      .toThrow(HEIC_UNSUPPORTED_MESSAGE);
  });

  it('refuses to name a content type for HEIC/HEIF', () => {
    expect(() => resolveImageContentType(new File(['image'], 'photo.heic')))
      .toThrow(HEIC_UNSUPPORTED_MESSAGE);
    expect(() => resolveImageContentType(new File(['image'], 'photo.heif', { type: 'image/heif' })))
      .toThrow(HEIC_UNSUPPORTED_MESSAGE);
    expect(() => resolveImageContentType(new File(['image'], 'photo.jpg', { type: 'image/heic' })))
      .toThrow(HEIC_UNSUPPORTED_MESSAGE);
  });

  it('names an omitted content type from the file extension instead of assuming JPEG', () => {
    expect(resolveImageContentType(new File(['image'], 'photo.png'))).toBe('image/png');
    expect(resolveImageContentType(new File(['image'], 'photo.jpg'))).toBe('image/jpeg');
    expect(resolveImageContentType(new File(['image'], 'photo.webp'))).toBe('image/webp');
    expect(resolveImageContentType(new File(['image'], 'photo.png', { type: 'image/png' }))).toBe('image/png');
    expect(resolveImageContentType(new File(['image'], 'photo.jpg', { type: 'image/jpeg' }))).toBe('image/jpeg');
    expect(resolveImageContentType(new File(['image'], 'photo.webp', { type: 'image/webp' }))).toBe('image/webp');
  });

  it('throws when S3 returns an HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    const file = new File(['image'], 'photo.jpg', { type: 'image/jpeg' });

    await expect(uploadImageWithSignedPost(upload, file))
      .rejects.toThrow('Image upload failed with HTTP 403');
  });

  it('posts the signed fields with the file last, so S3 can evaluate the policy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['image'], 'photo.jpg', { type: 'image/jpeg' });

    await uploadImageWithSignedPost(upload, file);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(upload.url);
    expect(init.method).toBe('POST');
    const body = init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('key')).toBe('wearable-items/user-1/res-1.jpg');
    expect(body.get('policy')).toBe('signed-policy');
    expect(body.get('x-amz-signature')).toBe('signature');
    expect(body.get('Content-Type')).toBe('image/jpeg');
    const parts = [...body.keys()];
    expect(parts[parts.length - 1]).toBe('file');
    expect(body.get('file')).toBe(file);
  });
});
