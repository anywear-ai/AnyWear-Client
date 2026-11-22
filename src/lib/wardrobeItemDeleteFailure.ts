import { getErrorMessage, getHttpStatus, getStringProperty } from './errors';
import { generationInProgressRefusal } from './generationInProgress';

/**
 * What a refused `DELETE /wardrobe/items/{item_id}` should say, and whether the
 * row is already gone.
 *
 * Issue 332 — the route has exactly two designed refusals and one object-proof
 * outcome:
 *
 * - `409 ITEM_NOT_ARCHIVED`: the item is in use. The Storage Box is the only path
 *   to deletion, so the sentence says "archive it first" and nothing was deleted.
 * - `409 GENERATION_IN_PROGRESS`: at least one outfit in the cascade has a running
 *   try-on, named in `details.blocking`. Nothing was deleted and no credit was
 *   refunded, so the sentence names the try-on and says to wait.
 * - `502 OBJECT_DELETION_INCOMPLETE`: the rows are gone and the item's gallery
 *   objects are still being cleaned up. That is a completed delete from the user's
 *   point of view, so it is not painted as a failure beside the control.
 *
 * The retired `409 RESOURCE_REFERENCED` (an outfit still lists the item) no longer
 * exists on this route: the cascade removes those outfits instead of refusing.
 */
export interface WardrobeItemDeleteFailure {
  /** The sentence the sending surface renders in its `role="alert"`, or null when there is none. */
  message: string | null;
  /**
   * True only for a 404: the row is already gone, so the surface closes and the
   * page states the removal instead of the surface reporting a failure.
   */
  gone: boolean;
  /**
   * True for a `502 OBJECT_DELETION_INCOMPLETE`: every row was deleted and only
   * background object cleanup is owed, so the surface closes as a success.
   */
  cleanupPending: boolean;
}

/** The page's `role="status"` sentence for a row that was already gone. */
export const ITEM_ALREADY_GONE_MESSAGE =
  'This item is no longer in your wardrobe, so it was removed from this list.';

/** The page's `role="status"` sentence for a delete whose objects are still being cleaned up. */
export const ITEM_CLEANUP_PENDING_MESSAGE =
  'Item deleted. Its images are still being cleaned up in the background.';

const CONNECTION_SENTENCE = 'Could not reach the server. Check your connection and try again.';
const REFUSED_SENTENCE = 'Could not delete this item.';
const ARCHIVE_FIRST_SENTENCE =
  'Nothing was deleted: an item has to be in the Storage Box before it can be deleted permanently. Archive it first.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function responseData(error: unknown): unknown {
  if (!isRecord(error) || !isRecord(error.response)) return undefined;
  return error.response.data;
}

/** The Service's error code, e.g. `ITEM_NOT_ARCHIVED`, when the body carried one. */
function errorCode(error: unknown): string | null {
  const data = responseData(error);
  return isRecord(data) ? (getStringProperty(data, 'error') ?? null) : null;
}

/**
 * Describe a rejected `DELETE /wardrobe/items/{item_id}`.
 *
 * A `404` is not a failure to report beside the control: the requested end state
 * already holds, so the surface closes and the page notice states it. A `401` is
 * the response interceptor's: it clears the session and redirects to `/login`
 * before the mutation settles, so no sentence is painted beside the redirect.
 */
export function describeWardrobeItemDeleteFailure(error: unknown): WardrobeItemDeleteFailure {
  const status = getHttpStatus(error);

  // No status at all means no response arrived: offline, DNS or TLS. A value that
  // is not even an error object is reported with the generic sentence rather than a
  // claim about the connection.
  if (status === undefined) {
    return {
      message: isRecord(error) ? CONNECTION_SENTENCE : getErrorMessage(error, REFUSED_SENTENCE),
      gone: false,
      cleanupPending: false,
    };
  }

  if (status === 404) return { message: ITEM_ALREADY_GONE_MESSAGE, gone: true, cleanupPending: false };

  // A 401 is the interceptor's to answer, not the surface's.
  if (status === 401) return { message: null, gone: false, cleanupPending: false };

  if (status === 502 && errorCode(error) === 'OBJECT_DELETION_INCOMPLETE') {
    return { message: ITEM_CLEANUP_PENDING_MESSAGE, gone: false, cleanupPending: true };
  }

  if (status >= 500) {
    return {
      message: `Could not delete this item (server error ${status}). Try again.`,
      gone: false,
      cleanupPending: false,
    };
  }

  if (status === 409) {
    const code = errorCode(error);
    if (code === 'ITEM_NOT_ARCHIVED') {
      return { message: ARCHIVE_FIRST_SENTENCE, gone: false, cleanupPending: false };
    }
    if (code === 'GENERATION_IN_PROGRESS') {
      return {
        message: generationInProgressRefusal(error, {
          fallbackName: 'An outfit in this list',
          target: 'item',
        }),
        gone: false,
        cleanupPending: false,
      };
    }
    // Any other 409: the Service's own message when it sent one.
    return { message: getErrorMessage(error, REFUSED_SENTENCE), gone: false, cleanupPending: false };
  }

  return { message: getErrorMessage(error, REFUSED_SENTENCE), gone: false, cleanupPending: false };
}

/** The sentence a refused archive or restore leaves beside its control. */
export function describeWardrobeItemLifecycleFailure(error: unknown, action: 'archive' | 'restore'): string {
  const status = getHttpStatus(error);
  if (status === 404) return 'This item is no longer in your wardrobe.';
  if (status === 401) return '';
  if (typeof status === 'number') return `Could not ${action} this item (status ${status}). Try again.`;
  return `Could not ${action} this item. Check your connection and try again.`;
}
