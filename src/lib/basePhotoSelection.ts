import type { GetVtoBasePhotos200Item } from '../api/model/getVtoBasePhotos200Item';

/** Where the Fitting Room's effective base-photo selection came from. */
export type BasePhotoSelectionSource = 'chosen' | 'default' | 'none';

export interface BasePhotoSelection {
  photoId: string | null;
  source: BasePhotoSelectionSource;
}

/**
 * Resolve the base photo the Fitting Room shows from the photo list and the user's
 * explicit choice.
 *
 * The API flags the caller's effective default on the list it returns (the
 * caller's pointer target, otherwise the shared system photo), so the resolved
 * selection needs no second request. A choice made during the visit wins while
 * its photo is still listed, because a refetch replaces the list and must not
 * replace the user's choice. When the chosen id is absent — a delete, or a
 * photo removed elsewhere — the flagged default takes over, and the first
 * flagged entry wins a malformed double flag because own photos precede system
 * photos in the response.
 */
export function resolveBasePhotoSelection(
  photos: readonly GetVtoBasePhotos200Item[] | null | undefined,
  chosenId: string | null,
): BasePhotoSelection {
  const list = Array.isArray(photos) ? photos : [];

  if (chosenId) {
    const chosen = list.find((photo) => photo.id === chosenId);
    if (chosen) {
      return { photoId: chosen.id, source: 'chosen' };
    }
  }

  const effectiveDefault = list.find((photo) => photo.isDefault);
  if (effectiveDefault) {
    return { photoId: effectiveDefault.id, source: 'default' };
  }

  return { photoId: null, source: 'none' };
}
