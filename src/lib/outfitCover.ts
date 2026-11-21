import { getOutfitLookImage } from './image-utils';
import { outfitHasActiveGeneration, type OutfitLookState } from './outfit-look';

/**
 * Issue 313 — the five cover states of a saved outfit, each with its own predicate.
 *
 * The two states that show no image are distinct facts and are never collapsed:
 *
 * - **never generated**: `latestGeneration == null && look == null`. The outfit has
 *   never been rendered — a set saved from the Fitting Room's `Save outfit` path
 *   lands here. It paints the Client's bundled placeholder graphic and offers
 *   `Generate look`, and it makes no image request and adds no API field.
 * - **image unavailable**: `look.generationId` is set while `look.url == null`. A
 *   generation *did* complete; this read could not sign its URL.
 *
 * Painting a freshly saved outfit as "image unavailable" would report a normal
 * save as a failure, and painting an unsigned completed look as "never generated"
 * would hide a record that exists.
 */
export type OutfitCoverState = 'look' | 'generating' | 'failed' | 'image-unavailable' | 'never-generated';

/** The cover copy of the states that have no image to paint. */
export const COVER_PLACEHOLDER: Record<Exclude<OutfitCoverState, 'look' | 'generating'>, string> = {
  failed: 'Last try-on failed',
  'image-unavailable': 'Image unavailable',
  'never-generated': 'No look yet',
};

/** `latestGeneration` and `look` are both null: nothing has ever been rendered. */
export function outfitWasNeverGenerated(outfit: OutfitLookState | null | undefined): boolean {
  return (outfit?.latestGeneration ?? null) === null && (outfit?.look ?? null) === null;
}

/** A completed record whose signed URL is missing: generated, but this read has no image. */
export function outfitLookIsImageUnavailable(outfit: OutfitLookState | null | undefined): boolean {
  const look = outfit?.look ?? null;
  if (look === null) return false;
  return typeof look.generationId === 'string' && look.generationId.length > 0 && look.url === null;
}

/**
 * The cover the card paints, in precedence order: a completed look with a signed
 * URL, then a running generation (which outranks the failed and empty states),
 * then a failed last generation, then the two no-image states above.
 */
export function outfitCoverState(outfit: OutfitLookState): OutfitCoverState {
  if (getOutfitLookImage(outfit.look)) return 'look';
  if (outfitHasActiveGeneration(outfit)) return 'generating';
  if (outfit.latestGeneration?.status === 'Failed') return 'failed';
  if (outfitLookIsImageUnavailable(outfit)) return 'image-unavailable';
  if (outfitWasNeverGenerated(outfit)) return 'never-generated';
  // A completed generation whose look the response omitted: the record exists,
  // the image does not, which is the unavailable state rather than a first look.
  return 'image-unavailable';
}

/** The placeholder sentence a cover state paints, or null when it paints an image or skeleton. */
export function coverPlaceholder(state: OutfitCoverState): string | null {
  return state === 'look' || state === 'generating' ? null : COVER_PLACEHOLDER[state];
}

/**
 * The action the card offers; a running generation offers none.
 *
 * A failed latest generation offers `Retry` even while an older completed look is
 * still painted; otherwise any completed look — signed or not — offers `New look`,
 * and a never-generated outfit offers `Generate look`.
 */
export function outfitActionLabel(outfit: OutfitLookState): string {
  if (outfit.latestGeneration?.status === 'Failed') return 'Retry';
  if (outfit.look) return 'New look';
  return 'Generate look';
}
