import { getStringProperty } from './errors';

/**
 * Issue 350 — the running try-on a `409 GENERATION_IN_PROGRESS` names.
 *
 * Two destructive confirmations refuse the same way: `DELETE /wardrobe/items/{id}`
 * and `DELETE /outfits/{id}` both answer `409 GENERATION_IN_PROGRESS` with the
 * attempts that hold them listed in `details.blocking`, one entry per outfit. Both
 * surfaces name the outfit and the attempt's status, so the person knows which
 * attempt to wait for; one reader and one sentence builder keep that shape in one
 * place instead of two nearly identical mappers.
 */
export interface RunningGeneration {
  /** The outfit whose attempt is running, when the Service named one. */
  outfitName: string | null;
  /** The attempt's status (`Pending` or `Processing`), when it is known. */
  status: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function responseData(error: unknown): unknown {
  if (!isRecord(error) || !isRecord(error.response)) return undefined;
  return error.response.data;
}

/**
 * The one running try-on a `409 GENERATION_IN_PROGRESS` named first, falling back
 * to the details-level status when the Service listed no blocker.
 */
export function firstBlocker(error: unknown): RunningGeneration {
  const data = responseData(error);
  const details = isRecord(data) ? data.details : undefined;
  const blocking = isRecord(details) ? details.blocking : undefined;
  const first = Array.isArray(blocking) && isRecord(blocking[0]) ? blocking[0] : undefined;
  if (!first) {
    return {
      outfitName: null,
      status: isRecord(details) ? (getStringProperty(details, 'status') ?? null) : null,
    };
  }
  return {
    outfitName: getStringProperty(first, 'outfitName') ?? null,
    status: getStringProperty(first, 'status') ?? null,
  };
}

/**
 * `"<outfit>" has a try-on still running (<status>)` — the clause that says which
 * outfit holds the delete and which attempt to wait for. `fallbackName` is what
 * the surface calls the blocker when neither the Service nor the outfit named one.
 */
export function runningTryOnClause(generation: RunningGeneration, fallbackName: string): string {
  const which = generation.outfitName ? `"${generation.outfitName}"` : fallbackName;
  const running = generation.status ? ` (${generation.status})` : '';
  return `${which} has a try-on still running${running}`;
}

/**
 * The sentence a surface leaves behind for a delete the Service refused with
 * `409 GENERATION_IN_PROGRESS`: nothing was deleted, and the sentence names the
 * outfit and the attempt's status so the person knows what to wait for.
 */
export function generationInProgressRefusal(
  error: unknown,
  options: { fallbackName: string; target: 'item' | 'outfit' },
): string {
  const subject = options.target === 'item' ? 'this item' : 'the outfit';
  const clause = runningTryOnClause(firstBlocker(error), options.fallbackName);
  return `Nothing was deleted: ${clause}. Wait for it to finish, then delete ${subject}.`;
}
