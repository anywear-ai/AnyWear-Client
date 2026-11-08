import { HEIC_UNSUPPORTED_MESSAGE } from './imageUpload';

/**
 * Everything the Client does to a picked or captured photo before it reserves an
 * upload: the file is decoded with its EXIF orientation baked into the pixels,
 * scaled so its longest edge is at most `MAX_IMAGE_DIMENSION`, flattened onto
 * white (JPEG has no alpha channel) and re-encoded as JPEG at the quality ladder
 * below until the result fits `MAX_PREPARED_BYTES`.
 *
 * The Service's signed POST policy compares the declared content type with the
 * signed one and the confirmation compares the stored bytes' signature with the
 * type, so the prepared file is JPEG whatever the original was: the reservation
 * can therefore always declare `image/jpeg`.
 */

/** The longest edge of a prepared image, in pixels. */
export const MAX_IMAGE_DIMENSION = 2048;
/** The largest prepared JPEG the batch and single-shot paths accept, in bytes. */
export const MAX_PREPARED_BYTES = 4 * 1024 * 1024;

/**
 * The encoding ladder: the initial encode, then at most three re-encodes. The
 * first two fall back in quality only; the last also drops the longest edge to
 * 80% of `MAX_IMAGE_DIMENSION`, which is the lever left when quality alone no
 * longer brings a noisy photo under the byte bound.
 */
export const PREPARE_ENCODING_LADDER = [
  { maxDimension: MAX_IMAGE_DIMENSION, quality: 0.85 },
  { maxDimension: MAX_IMAGE_DIMENSION, quality: 0.75 },
  { maxDimension: MAX_IMAGE_DIMENSION, quality: 0.65 },
  { maxDimension: Math.round(MAX_IMAGE_DIMENSION * 0.8), quality: 0.65 },
] as const;

/** A picked file the browser could not decode, or a canvas it could not paint. */
export const IMAGE_DECODE_FAILED_MESSAGE = 'Could not process this image';
/** Every ladder step still exceeded `MAX_PREPARED_BYTES`. */
export const IMAGE_TOO_LARGE_MESSAGE = 'Image is too large after processing';

/**
 * HEIF brands whose bytes the Client refuses.
 *
 * The Service accepts JPEG, PNG and WebP signatures, so a HEIF photo can only
 * confirm as a failure. The check reads the bytes because a camera file can
 * arrive named `.jpg` and declared `image/jpeg` — wry writes camera shots as
 * `JPEG_<timestamp>_<random>.jpg` — so neither the name nor the MIME type says
 * what the bytes are. `mif1` and `msf1` are the generic HEIF brands; `heic`,
 * `heix`, `hevc` and `hevx` name the HEVC-coded variants.
 */
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heif', 'mif1', 'msf1']);

/** True when the first `ftyp` box names a brand the Service cannot store. */
export async function hasHeifSignature(file: Blob): Promise<boolean> {
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (header.length < 12) return false;
  const boxType = String.fromCharCode(header[4], header[5], header[6], header[7]);
  if (boxType !== 'ftyp') return false;
  const brand = String.fromCharCode(header[8], header[9], header[10], header[11]).toLowerCase();
  return HEIF_BRANDS.has(brand);
}

async function decodeImage(file: File): Promise<ImageBitmap> {
  try {
    // `from-image` bakes the EXIF orientation into the bitmap, so the pixels the
    // canvas paints are already upright and the encoded JPEG carries no EXIF.
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(IMAGE_DECODE_FAILED_MESSAGE);
  }
}

function paintOntoCanvas(source: ImageBitmap, maxDimension: number): HTMLCanvasElement {
  const scale = Math.min(1, maxDimension / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error(IMAGE_DECODE_FAILED_MESSAGE);
  // JPEG has no alpha channel. Filling first keeps a transparent PNG's empty
  // pixels white instead of the black an unpainted canvas would encode.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error(IMAGE_DECODE_FAILED_MESSAGE));
    }, 'image/jpeg', quality);
  });
}

/** The prepared file's name: the original stem with the JPEG extension. */
function preparedFileName(name: string): string {
  const stem = name.replace(/\.[^./\\]+$/, '');
  return `${stem || 'photo'}.jpg`;
}

/**
 * Prepare one photo for upload, returning the JPEG that will be reserved,
 * posted and confirmed. Throws `HEIC_UNSUPPORTED_MESSAGE` for HEIF bytes before
 * any decode, `IMAGE_DECODE_FAILED_MESSAGE` when the browser cannot decode the
 * file, and `IMAGE_TOO_LARGE_MESSAGE` when the ladder runs out.
 */
export async function prepareImageForUpload(file: File): Promise<File> {
  if (await hasHeifSignature(file)) {
    throw new Error(HEIC_UNSUPPORTED_MESSAGE);
  }

  const bitmap = await decodeImage(file);
  try {
    for (const step of PREPARE_ENCODING_LADDER) {
      const canvas = paintOntoCanvas(bitmap, step.maxDimension);
      const blob = await encodeJpeg(canvas, step.quality);
      if (blob.size <= MAX_PREPARED_BYTES) {
        // `lastModified` is the preparation instant, so re-preparing the same
        // photo on Retry is a fresh file rather than a stale duplicate.
        return new File([blob], preparedFileName(file.name), {
          type: 'image/jpeg',
          lastModified: Date.now(),
        });
      }
    }
    throw new Error(IMAGE_TOO_LARGE_MESSAGE);
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}
