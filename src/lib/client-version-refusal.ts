/**
 * The Service's terminal refusal of a Client build below its version floor.
 *
 * The refusal is HTTP 400 with `error: "CLIENT_VERSION_UNSUPPORTED"` and
 * `details: { minimum_client_version, received_client_version }`
 * (ADR-0026 §2). Status alone cannot discriminate: `VALIDATION_ERROR` is also a
 * 400, so the body code is the rail. The two numbers are display data read
 * best-effort: a refusal whose `details` is absent or malformed still latches,
 * because routing a genuine refusal back into per-screen generic handling is
 * exactly what the blocking screen exists to prevent.
 */
export interface ClientVersionRefusal {
  /** The version the Service requires, when the body named a number. */
  readonly minimumClientVersion: number | null;
  /** The version the Service received, when the body named a number. */
  readonly receivedClientVersion: number | null;
  /**
   * Whether the body carried a `details` object at all. The screen says what the
   * Service received only when the Service reported it, so a malformed body
   * never makes the screen claim a fact the response did not prove.
   */
  readonly detailsReported: boolean;
}

/** The body code a refusal carries; no other 400 is a refusal. */
export const CLIENT_VERSION_UNSUPPORTED = 'CLIENT_VERSION_UNSUPPORTED';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A reported version, or null when the body did not name one. `0` is a value. */
function readVersion(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Recognises a refusal from a response's status and its parsed body.
 *
 * Used by both callers that can receive it: the Axios response interceptor
 * (whose body Axios has already parsed) and the SSE connection (which parses
 * the body itself). One recognition serves both so the two paths cannot drift.
 */
export function parseClientVersionRefusal(
  status: number | undefined,
  body: unknown,
): ClientVersionRefusal | null {
  if (status !== 400) return null;
  if (!isRecord(body) || body.error !== CLIENT_VERSION_UNSUPPORTED) return null;

  const details = isRecord(body.details) ? body.details : null;
  return {
    minimumClientVersion: readVersion(details?.minimum_client_version),
    receivedClientVersion: readVersion(details?.received_client_version),
    detailsReported: details !== null,
  };
}

/** The refusal carried by an Axios-shaped failure, or null for every other answer. */
export function getClientVersionRefusal(error: unknown): ClientVersionRefusal | null {
  if (!isRecord(error)) return null;
  const response = error.response;
  if (!isRecord(response)) return null;
  return parseClientVersionRefusal(
    typeof response.status === 'number' ? response.status : undefined,
    response.data,
  );
}
