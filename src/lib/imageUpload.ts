/**
 * The largest picked file the Client will try to decode.
 *
 * This is not the upload bound: the prepared JPEG is at most 4 MiB
 * (`imagePreparation.ts`) and the Service's signed POST policy caps the object at
 * 10 MiB. The guard only has to admit the camera and gallery originals the
 * pipeline can still shrink, so a 10–30 MiB phone photo is not refused before
 * preparation ever runs.
 */
export const MAX_IMAGE_SIZE_BYTES = 30 * 1024 * 1024;
/** Extensions accepted when the browser omits the MIME type. */
const ACCEPTED_IMAGE_EXTENSIONS = /\.(?:jpe?g|png|webp)$/i;
const HEIC_FILE_EXTENSION = /\.(?:heic|heif)$/i;
const HEIC_CONTENT_TYPES = new Set(['image/heic', 'image/heif']);

export const HEIC_UNSUPPORTED_MESSAGE =
  'HEIC/HEIF photos are not supported. On iPhone, set Settings > Camera > Formats > "Most Compatible", or export the photo as a JPEG, then try again.';

function isHeicOrHeif(file: File): boolean {
  return HEIC_CONTENT_TYPES.has(file.type.toLowerCase()) || HEIC_FILE_EXTENSION.test(file.name);
}

/** The signed S3 POST policy the service issues for one upload. */
export interface SignedUploadPost {
  url: string;
  fields: Record<string, string>;
}

/**
 * Feedback only. The limits that matter are enforced by the service and by the
 * signed upload policy: a body larger than the policy's range, or of a
 * different content type, is refused by S3 whatever this browser does.
 *
 * The format guard runs before every other rule because the pipeline cannot
 * decode that format at all: a file whose MIME type the browser omitted still
 * has to get the format guidance, and an oversized one is better told to
 * re-encode than told its file is too big.
 */
export function validateImageFile(file: File): void {
  if (isHeicOrHeif(file)) {
    throw new Error(HEIC_UNSUPPORTED_MESSAGE);
  }
  const hasImageType = file.type.startsWith('image/');
  const hasImageExtension = ACCEPTED_IMAGE_EXTENSIONS.test(file.name);
  if (!hasImageType && !(!file.type && hasImageExtension)) {
    throw new Error('Select an image file');
  }
  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    throw new Error('Image must be 30MB or smaller');
  }
}

/**
 * The content type to reserve.
 *
 * The service only accepts its allow-listed types and derives the object
 * extension from the declared type, so a camera file with an empty MIME type has
 * to be named from its extension rather than defaulted to JPEG — otherwise the
 * bytes and the declared type would disagree and the confirmation would refuse
 * the upload.
 *
 * The same format guard runs here too, so a caller that skipped validation
 * cannot reserve the format the pipeline cannot process or fall through to the
 * JPEG default.
 */
export function resolveImageContentType(file: File): string {
  if (isHeicOrHeif(file)) {
    throw new Error(HEIC_UNSUPPORTED_MESSAGE);
  }
  if (file.type) return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * Upload the file through the signed POST policy.
 *
 * The policy's fields must be sent verbatim and the file part must come last;
 * S3 rejects a form that omits or alters a signed field, a body outside the
 * policy's size range, and a part whose content type differs from the signed
 * one. There is no client-side call that can relax those conditions.
 */
export async function uploadImageWithSignedPost(upload: SignedUploadPost, file: File): Promise<void> {
  const form = new FormData();
  for (const [name, value] of Object.entries(upload.fields)) {
    form.append(name, value);
  }
  form.append('file', file);

  const response = await fetch(upload.url, { method: 'POST', body: form });

  if (!response.ok) {
    throw new Error(`Image upload failed with HTTP ${response.status}`);
  }
}
