import { getErrorMessage } from './errors';

/**
 * Issue 313 — the member refusals both compose paths share.
 *
 * `POST /vto/generations`, `POST /outfits` and `GET /outfits/lookup` run the same
 * ownership, Storage-Box and image validation, and they answer a refused member
 * set with one `400 VALIDATION_ERROR` whose `details` names the ids by reason.
 * The page reads them from the one place, so no path can silently drop an id and
 * produce a different outfit than the one the user selected.
 */
export interface RefusedItemIds {
  archivedItemIds: string[];
  missingItemIds: string[];
  imageLessItemIds: string[];
  duplicateItemIds: string[];
}

const EMPTY_REFUSAL: RefusedItemIds = {
  archivedItemIds: [],
  missingItemIds: [],
  imageLessItemIds: [],
  duplicateItemIds: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A `details` member list, ignoring anything that is not an array of non-empty strings. */
function readIdList(details: Record<string, unknown>, key: keyof RefusedItemIds): string[] {
  const value = details[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/**
 * The ids a refusal names, read from the response body's `details`.
 *
 * The body is `{ code, message, details: { archivedItemIds?, … } }`. A 400 whose
 * `details` is something else — Zod's `details[].message` list, a body the
 * Client cannot parse, a network failure — yields no ids, which the caller
 * reports as the Service's own sentence rather than inventing a selection change.
 */
export function readRefusedItemIds(error: unknown): RefusedItemIds {
  if (!isRecord(error)) return EMPTY_REFUSAL;
  const response = error.response;
  if (!isRecord(response) || !isRecord(response.data)) return EMPTY_REFUSAL;
  const details = response.data.details;
  if (!isRecord(details)) return EMPTY_REFUSAL;
  return {
    archivedItemIds: readIdList(details, 'archivedItemIds'),
    missingItemIds: readIdList(details, 'missingItemIds'),
    imageLessItemIds: readIdList(details, 'imageLessItemIds'),
    duplicateItemIds: readIdList(details, 'duplicateItemIds'),
  };
}

/** Every id a refusal named, in one list, with no duplicates and no order change. */
export function refusedItemIds(refusal: RefusedItemIds): string[] {
  const seen = new Set<string>();
  for (const key of ['archivedItemIds', 'missingItemIds', 'imageLessItemIds', 'duplicateItemIds'] as const) {
    for (const id of refusal[key]) seen.add(id);
  }
  return [...seen];
}

function countLabel(count: number, plural: string, singular: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * The sentence a named refusal shows. It states every reason in the service's
 * own buckets so the user knows what changed, and it ends with the retry the
 * page expects: the named ids are untucked, the room is re-read, and the person
 * tries again on the selection they can now see.
 */
export function describeRefusedItems(refusal: RefusedItemIds): string | null {
  const reasons: string[] = [];
  if (refusal.archivedItemIds.length > 0) {
    reasons.push(`${countLabel(refusal.archivedItemIds.length, 'pieces are', 'piece is')} in the Storage Box`);
  }
  if (refusal.missingItemIds.length > 0) {
    reasons.push(`${countLabel(refusal.missingItemIds.length, 'pieces are', 'piece is')} no longer in your wardrobe`);
  }
  if (refusal.imageLessItemIds.length > 0) {
    reasons.push(`${countLabel(refusal.imageLessItemIds.length, 'pieces have', 'piece has')} no image yet`);
  }
  if (refusal.duplicateItemIds.length > 0) {
    reasons.push(`${countLabel(refusal.duplicateItemIds.length, 'pieces were', 'piece was')} selected twice`);
  }
  if (reasons.length === 0) return null;
  return `Nothing was sent: ${reasons.join('; ')}. The named pieces were removed from your selection — check To try on and try again.`;
}

/**
 * The one refusal handler both write paths and the lookup use.
 *
 * It returns the ids to untick plus the sentence to show. An unnamed refusal
 * keeps the Service's own message, because a 400 this handler cannot explain is
 * still a failure the user has to see.
 */
export function describeSelectionRefusal(error: unknown): { untickIds: string[]; message: string } {
  const refusal = readRefusedItemIds(error);
  const untickIds = refusedItemIds(refusal);
  const message = describeRefusedItems(refusal)
    ?? getErrorMessage(error, 'That selection could not be used. Check To try on and try again.');
  return { untickIds, message };
}
