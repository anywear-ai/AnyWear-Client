import { getHttpStatus } from './errors';

/** The Service's name for a delete that committed its rows and still owes objects. */
const INCOMPLETE_DELETE_ERROR = 'OBJECT_DELETION_INCOMPLETE';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * How many image files a rejected `DELETE /vto/generations/{id}` left
 * unconfirmed, or null when the rejection was not that answer.
 *
 * A `502 OBJECT_DELETION_INCOMPLETE` means the generation's rows were deleted
 * and at least one stored object's absence was not proved. Its
 * `details.retained_key_count` is the only number the Client may state, and the
 * contract gives it a minimum of 1: a body that carries no positive integer
 * there — an older Service that sent the raw key list, the outfit-shaped
 * payload, a truncated body — is read as no count rather than rounded to `0`
 * or to any other number. Every other rejection (another status, another
 * `error`, a transport failure) also returns null, so the surface stays as
 * silent as it was before for those.
 *
 * The field names are the generated `DeleteVtoGenerationsGenerationId502`
 * model's. This module reads them at runtime instead of casting the body,
 * because the body it receives may predate that contract.
 */
export function retainedKeyCountFromGenerationDelete(error: unknown): number | null {
  if (getHttpStatus(error) !== 502) return null;

  const response = isRecord(error) ? error.response : undefined;
  const data = isRecord(response) ? response.data : undefined;
  if (!isRecord(data) || data.error !== INCOMPLETE_DELETE_ERROR) return null;

  const details = data.details;
  if (!isRecord(details)) return null;

  const count = details.retained_key_count;
  return typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : null;
}
