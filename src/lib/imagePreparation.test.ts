// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_DECODE_FAILED_MESSAGE,
  IMAGE_TOO_LARGE_MESSAGE,
  MAX_IMAGE_DIMENSION,
  MAX_PREPARED_BYTES,
  PREPARE_ENCODING_LADDER,
  hasHeifSignature,
  prepareImageForUpload,
} from './imagePreparation';
import { HEIC_UNSUPPORTED_MESSAGE } from './imageUpload';

const MIB = 1024 * 1024;

/** A real File whose bytes the guards can slice; only the size matters here. */
function imageFile(name = 'photo.jpg', type = 'image/jpeg', size = 1024): File {
  return new File([new Uint8Array(size)], name, { type });
}

/** A HEIF file: an ISO base-media `ftyp` box whose major brand is `heic`. */
function heifFile(name = 'JPEG_1720000000000_1234.jpg'): File {
  const header = new Uint8Array(24);
  header.set([0x00, 0x00, 0x00, 0x18], 0);
  header.set([0x66, 0x74, 0x79, 0x70], 4); // "ftyp"
  header.set([0x68, 0x65, 0x69, 0x63], 8); // "heic"
  return new File([header], name, { type: 'image/jpeg' });
}

interface Encode {
  width: number;
  height: number;
  type: string;
  quality: number;
}

/**
 * jsdom has no canvas implementation, so the suite stubs the two calls the
 * module makes: `getContext('2d')` paints, and `toBlob` answers with a Blob whose
 * size comes from `sizes` in call order. The last size repeats if the ladder
 * outruns the list.
 */
function stubCanvas(sizes: number[]): { encodes: Encode[] } {
  const encodes: Encode[] = [];
  let calls = 0;

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
    return {
      fillStyle: '#000000',
      fillRect: () => undefined,
      drawImage: () => undefined,
    } as unknown as CanvasRenderingContext2D;
  });

  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type?: string,
    quality?: number,
  ) {
    encodes.push({ width: this.width, height: this.height, type: type ?? '', quality: quality ?? 0 });
    const size = sizes[Math.min(calls, sizes.length - 1)];
    calls += 1;
    callback(new Blob([new Uint8Array(size)], { type: 'image/jpeg' }));
  });

  return { encodes };
}

function stubBitmap(width: number, height: number) {
  const close = vi.fn();
  const decode = vi.fn(async () => ({ width, height, close }) as unknown as ImageBitmap);
  vi.stubGlobal('createImageBitmap', decode);
  return { decode, close };
}

function stubDecodeFailure() {
  const decode = vi.fn(async () => {
    throw new Error('The source image could not be decoded.');
  });
  vi.stubGlobal('createImageBitmap', decode);
  return decode;
}

describe('hasHeifSignature', () => {
  it('reads the ftyp box instead of trusting a JPEG name and MIME type', async () => {
    const cameraShot = heifFile();
    expect(cameraShot.name).toMatch(/\.jpg$/);
    expect(cameraShot.type).toBe('image/jpeg');

    await expect(hasHeifSignature(cameraShot)).resolves.toBe(true);
  });

  it('leaves JPEG, PNG and short files alone', async () => {
    const jpeg = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])], 'photo.jpg');
    await expect(hasHeifSignature(jpeg)).resolves.toBe(false);
    await expect(hasHeifSignature(imageFile('photo.png', 'image/png'))).resolves.toBe(false);
    await expect(hasHeifSignature(new File(['tiny'], 'tiny.jpg'))).resolves.toBe(false);
  });
});

describe('prepareImageForUpload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('rejects HEIF bytes before decoding them', async () => {
    const { decode } = stubBitmap(4000, 3000);
    stubCanvas([1024]);

    await expect(prepareImageForUpload(heifFile())).rejects.toThrow(HEIC_UNSUPPORTED_MESSAGE);
    expect(decode).not.toHaveBeenCalled();
  });

  it('bakes the EXIF orientation into the pixels and drops it from the output', async () => {
    // Orientation 6 is a quarter turn: the decoder is asked for the upright
    // bitmap, so the painted pixels are already rotated and the JPEG carries no
    // EXIF segment for a later viewer to apply a second time.
    const { decode } = stubBitmap(4000, 3000);
    const { encodes } = stubCanvas([1024]);

    const prepared = await prepareImageForUpload(imageFile('IMG_0001.jpg'));

    expect(decode).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledWith(expect.any(File), { imageOrientation: 'from-image' });
    expect(encodes[0]).toEqual({ width: 2048, height: 1536, type: 'image/jpeg', quality: 0.85 });
    expect(prepared.type).toBe('image/jpeg');
    expect(prepared.name).toBe('IMG_0001.jpg');
  });

  it('compresses a 4000x3000 photo to a 2048 longest edge, JPEG, under 4 MiB', async () => {
    stubBitmap(4000, 3000);
    const { encodes } = stubCanvas([2 * MIB]);

    const prepared = await prepareImageForUpload(imageFile('IMG_0002.jpeg'));

    expect(Math.max(encodes[0].width, encodes[0].height)).toBe(MAX_IMAGE_DIMENSION);
    expect(prepared.size).toBeLessThanOrEqual(MAX_PREPARED_BYTES);
    expect(prepared.type).toBe('image/jpeg');
    expect(prepared.name).toBe('IMG_0002.jpg');
  });

  it('leaves a photo smaller than the bound at its own size and names it as JPEG', async () => {
    stubBitmap(800, 600);
    const { encodes } = stubCanvas([64 * 1024]);

    const prepared = await prepareImageForUpload(imageFile('top.png', 'image/png'));

    expect(encodes).toHaveLength(1);
    expect(encodes[0]).toMatchObject({ width: 800, height: 600, quality: 0.85 });
    expect(prepared.name).toBe('top.jpg');
    expect(prepared.type).toBe('image/jpeg');
  });

  it('falls back through 0.75 then 0.65 and stops at the first encode under 4 MiB', async () => {
    stubBitmap(4000, 3000);
    const { encodes } = stubCanvas([5 * MIB, 5 * MIB, 3 * MIB]);

    const prepared = await prepareImageForUpload(imageFile('noise.jpg'));

    expect(encodes.map((encode) => encode.quality)).toEqual([0.85, 0.75, 0.65]);
    // Every attempt before the accepting one kept the 2048 bound.
    expect(encodes.slice(0, 2).map((encode) => encode.width)).toEqual([2048, 2048]);
    expect(prepared.size).toBeLessThanOrEqual(MAX_PREPARED_BYTES);
  });

  it('drops the longest edge to 80% on the last step and then gives up', async () => {
    stubBitmap(4000, 3000);
    const { encodes } = stubCanvas([5 * MIB, 5 * MIB, 5 * MIB, 5 * MIB]);

    await expect(prepareImageForUpload(imageFile('noise.jpg'))).rejects.toThrow(IMAGE_TOO_LARGE_MESSAGE);

    expect(encodes).toHaveLength(PREPARE_ENCODING_LADDER.length);
    expect(encodes.map((encode) => encode.quality)).toEqual([0.85, 0.75, 0.65, 0.65]);
    expect(encodes[3].width).toBe(Math.round(MAX_IMAGE_DIMENSION * 0.8));
    expect(encodes[3].height).toBe(1229);
  });

  it('reports a decode failure instead of reserving an empty upload', async () => {
    stubDecodeFailure();
    stubCanvas([1024]);

    await expect(prepareImageForUpload(imageFile('broken.jpg'))).rejects.toThrow(IMAGE_DECODE_FAILED_MESSAGE);
  });
});
