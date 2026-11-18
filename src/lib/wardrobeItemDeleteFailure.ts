import { getErrorMessage, getHttpStatus, getStringProperty } from './errors';

/**
 * What a refused `DELETE /wardrobe/items/{id}` should say, and whether the row
 * is already gone.
 *
 * Both Wardrobe delete surfaces — the grid card's page-level panel and the item
 * details dialog's in-place question — call this one module, so the same status
 * and body always produce the same sentence in both places.
 */
export interface WardrobeItemDeleteFailure {
  /** The sentence the sending surface renders in its `role="alert"`, or null when there is none. */
  message: string | null;
  /**
   * True only for a 404: the row is already gone, so the surface closes and the
   * page states the removal instead of the surface reporting a failure.
   */
  gone: boolean;
}

/** The Service's name for an outfit row, as `details.dependent_resources[].resource` spells it. */
const OUTFIT_RESOURCE = 'outfit';

/** The page's `role="status"` sentence for a row that was already gone. */
export const ITEM_ALREADY_GONE_MESSAGE =
  'This item is no longer in your wardrobe, so it was removed from this list.';

const OTHER_DEPENDENT_MESSAGE = 'Something still depends on this item, so it was not deleted.';
const CONNECTION_SENTENCE = 'Could not reach the server. Check your connection and try again.';
const REFUSED_SENTENCE = 'Could not delete this item.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function responseData(error: unknown): unknown {
  if (!isRecord(error) || !isRecord(error.response)) return undefined;
  return error.response.data;
}

/**
 * Describe a rejected `DELETE /wardrobe/items/{id}`.
 *
 * The route answers a refused delete with `409 RESOURCE_REFERENCED` when an
 * outfit still lists the item, `404` when the row is already gone, `401` for an
 * expired session, and a 5xx or a transport failure for everything else. The
 * `409` is the ordinary case on this page — an item grouped into an outfit —
 * so its `outfit` dependent becomes the sentence: the count is the Service's,
 * the wording is the Client's because the hint names database rows while the
 * person reads outfits. Any other `409` keeps the Service's own hint, which is
 * better than anything the Client could say about a resource it does not name.
 *
 * A `404` is not a failure to report beside the control: the requested end
 * state already holds, so the surface closes and the page notice states it.
 * A `401` is the response interceptor's: it clears the session and redirects to
 * `/login` before the mutation settles, so the mapping describes nothing and no
 * sentence is painted beside the redirect.
 */
export function describeWardrobeItemDeleteFailure(error: unknown): WardrobeItemDeleteFailure {
  const status = getHttpStatus(error);

  // No status at all means no response arrived: offline, DNS or TLS. A value
  // that is not even an error object is reported with the generic sentence
  // rather than a claim about the connection.
  if (status === undefined) {
    return {
      message: isRecord(error) ? CONNECTION_SENTENCE : getErrorMessage(error, REFUSED_SENTENCE),
      gone: false,
    };
  }

  if (status === 404) return { message: ITEM_ALREADY_GONE_MESSAGE, gone: true };

  // A 401 is the interceptor's to answer, not the surface's.
  if (status === 401) return { message: null, gone: false };

  if (status >= 500) {
    return { message: `Could not delete this item (server error ${status}). Try again.`, gone: false };
  }

  if (status === 409) return describeReferenceConflict(error);

  // 400, 403 and every other refused status: the Service's message when it sent one.
  return { message: getErrorMessage(error, REFUSED_SENTENCE), gone: false };
}

/** The 409 rows: the designed "an outfit still lists this item" refusal. */
function describeReferenceConflict(error: unknown): WardrobeItemDeleteFailure {
  const data = responseData(error);
  const details = isRecord(data) ? data.details : undefined;
  const dependents = isRecord(details) ? details.dependent_resources : undefined;

  const outfit = Array.isArray(dependents)
    ? dependents.find((entry) => isRecord(entry) && entry.resource === OUTFIT_RESOURCE)
    : undefined;

  if (isRecord(outfit)) {
    const count = outfit.count;
    // `count` is optional in the contract, and a zero or negative value cannot
    // describe an outfit that holds the item, so both read as "one or more".
    if (typeof count === 'number' && count === 1) {
      return {
        message:
          'Nothing was deleted: this item is still in 1 outfit. Remove it from that outfit, or delete the outfit. An outfit cannot be saved with no items, so if this is its only item, delete it.',
        gone: false,
      };
    }
    if (typeof count === 'number' && count > 1) {
      return {
        message: `Nothing was deleted: this item is still in ${count} outfits. Remove it from those outfits, or delete them. An outfit cannot be saved with no items, so an outfit holding only this item has to be deleted.`,
        gone: false,
      };
    }
    return {
      message:
        'Nothing was deleted: this item is still in one or more outfits. Remove it from those outfits, or delete them. An outfit cannot be saved with no items, so an outfit holding only this item has to be deleted.',
      gone: false,
    };
  }

  // An unrecognised resource, an empty list or no `details`: the Service's own
  // hint when it sent one, and never an outfit the Service did not name.
  return {
    message: getStringProperty(details, 'hint') ?? OTHER_DEPENDENT_MESSAGE,
    gone: false,
  };
}
