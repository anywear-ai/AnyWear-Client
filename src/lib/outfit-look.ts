/**
 * Look state shared by the Wardrobe cards and the Fitting Room's try-on result.
 *
 * `latestGeneration` describes what is happening now (any status) while `look`
 * describes what the outfit looks like (newest complete generation). The card
 * shows both: the last look under a live badge. Polling exists only while a
 * returned generation is Pending or Processing; a terminal status (Complete or
 * Failed) stops it.
 */
export interface OutfitLookState {
  latestGeneration?: { status: string } | null;
  look?: { generationId: string; url: string | null } | null;
}

/** The statuses that mean "a generation is still running for this outfit". */
export const ACTIVE_LOOK_STATUSES: readonly string[] = ['Pending', 'Processing'];

/** How often an outfit list with an active generation is re-read. */
export const OUTFIT_LOOK_POLL_INTERVAL_MS = 10_000;

export function outfitHasActiveGeneration(outfit: OutfitLookState | null | undefined): boolean {
  const status = outfit?.latestGeneration?.status;
  return typeof status === 'string' && ACTIVE_LOOK_STATUSES.includes(status);
}

export function outfitsHaveActiveGeneration(outfits: readonly OutfitLookState[] | undefined): boolean {
  return Array.isArray(outfits) && outfits.some(outfitHasActiveGeneration);
}

/**
 * The outfits query's `refetchInterval`: a fixed interval while any returned
 * generation is Pending or Processing, and `false` once none is. It reads the
 * response it is given, so an outfit page with no active generation never polls.
 */
export function outfitLookRefetchInterval(data: { outfits?: OutfitLookState[] } | undefined): number | false {
  return outfitsHaveActiveGeneration(data?.outfits) ? OUTFIT_LOOK_POLL_INTERVAL_MS : false;
}
