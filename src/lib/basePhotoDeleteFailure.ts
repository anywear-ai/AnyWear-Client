import { getErrorMessage, getHttpStatus, getStringProperty } from './errors';

/** What a refused base-photo delete should say, and whether the row is already gone. */
export interface BasePhotoDeleteFailure {
  /** The sentence the card renders under its image, or null when there is none. */
  message: string | null;
  /** True only for a 404: the row is already gone, so the list refreshes silently. */
  refresh: boolean;
}

const FALLBACK = 'Could not remove this photo.';
const CONNECTION_SENTENCE = 'Could not reach the server. Check your connection and try again.';

/** The Service's name for a try-on row; the Client's word for it is "try-on". */
const TRY_ON_RESOURCE = 'outfit_generation';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function responseData(error: unknown): unknown {
  if (!isRecord(error) || !isRecord(error.response)) return undefined;
  return error.response.data;
}

/**
 * Describe a rejected `DELETE /vto/base-photos/{id}`.
 *
 * The Service answers a refused delete with a 403, a 404, a 409 that names the
 * dependent resources, or a 5xx. A 409 is the designed refusal for a photo a
 * try-on references, so its count becomes the card's sentence: the number is
 * the Service's, the wording is the Client's, because the hint names the
 * database row (`outfit_generation`) and the Client calls that row a try-on.
 * Any other 409 keeps the Service's own hint, which is better than anything the
 * card could say about a resource it does not name.
 *
 * A 404 is not a failure to report: the requested end state already holds, so
 * the card leaves with the refreshed list and no sentence is shown. A 401 is
 * the interceptor's: it clears the session and redirects to `/login` before the
 * mutation settles, so the mapping describes nothing for it.
 */
export function describeBasePhotoDeleteFailure(error: unknown): BasePhotoDeleteFailure {
  const status = getHttpStatus(error);

  // No status at all means no response arrived: offline, DNS or TLS. A value
  // that is not even an error object is reported with the generic sentence
  // rather than a claim about the connection.
  if (status === undefined) {
    return {
      message: isRecord(error) ? CONNECTION_SENTENCE : getErrorMessage(error, FALLBACK),
      refresh: false,
    };
  }

  if (status === 404) return { message: null, refresh: true };

  // A 401 is the interceptor's to answer, not the card's: the response
  // interceptor clears the session and redirects to `/login` before the
  // mutation settles, so the card is no longer on screen. Returning no
  // sentence keeps the redirect from printing an error beside it.
  if (status === 401) return { message: null, refresh: false };

  if (status >= 500) {
    return {
      message: `Could not remove this photo (server error ${status}). Try again.`,
      refresh: false,
    };
  }

  if (status === 409) return describeReferenceConflict(error);

  // 403 and every other refused status: the Service's message when it sent one.
  return { message: getErrorMessage(error, FALLBACK), refresh: false };
}

/** The 409 rows: the designed "still referenced by a try-on" refusal. */
function describeReferenceConflict(error: unknown): BasePhotoDeleteFailure {
  const data = responseData(error);
  const details = isRecord(data) ? data.details : undefined;
  const dependents = isRecord(details) ? details.dependent_resources : undefined;

  const tryOn = Array.isArray(dependents)
    ? dependents.find((entry) => isRecord(entry) && entry.resource === TRY_ON_RESOURCE)
    : undefined;

  if (isRecord(tryOn)) {
    const count = tryOn.count;
    return {
      message:
        typeof count === 'number' && count > 0
          ? `This photo is used by ${count} try-on(s). Delete it/them in History first.`
          : 'This photo is used by a try-on. Delete it in History first.',
      refresh: false,
    };
  }

  // `count` is optional in the contract, and an unrecognised resource is not
  // the Client's to describe; both keep the Service's own wording.
  return {
    message: getStringProperty(details, 'hint') ?? getErrorMessage(error, FALLBACK),
    refresh: false,
  };
}
