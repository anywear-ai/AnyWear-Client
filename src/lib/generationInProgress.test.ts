import { describe, it, expect } from 'vitest';
import {
  firstBlocker,
  generationInProgressRefusal,
  runningTryOnClause,
} from './generationInProgress';

/**
 * Issue 350 — one reader for the Service's `409 GENERATION_IN_PROGRESS` shape.
 *
 * The wardrobe item delete and the outfit delete refuse the same way and name the
 * same thing: the outfit whose try-on is running and the attempt's status. The
 * clause and the refusal are asserted here so both confirmations share one wording
 * instead of two nearly identical sentences.
 */
function httpError(status: number, data?: unknown) {
  return { response: { status, data } };
}

function generationInProgress(details: Record<string, unknown>) {
  return httpError(409, {
    error: 'GENERATION_IN_PROGRESS',
    message: 'A try-on is still running',
    details,
  });
}

describe('firstBlocker', () => {
  it('reads the outfit name and status from details.blocking[0]', () => {
    expect(firstBlocker(generationInProgress({
      generation_id: 'gen-1',
      status: 'Pending',
      blocking: [
        { outfitId: 'outfit-1', outfitName: 'Weekend Casual', generationId: 'gen-1', status: 'Pending' },
        { outfitId: 'outfit-2', outfitName: 'Office', generationId: 'gen-2', status: 'Processing' },
      ],
    }))).toEqual({ outfitName: 'Weekend Casual', status: 'Pending' });
  });

  it('falls back to the details-level status when no blocker is listed', () => {
    expect(firstBlocker(generationInProgress({ generation_id: 'gen-1', status: 'Processing' })))
      .toEqual({ outfitName: null, status: 'Processing' });
  });

  it('names nothing for an error that carries no body', () => {
    expect(firstBlocker(new Error('Network Error'))).toEqual({ outfitName: null, status: null });
  });
});

describe('runningTryOnClause', () => {
  it('names the outfit and the attempt', () => {
    expect(runningTryOnClause({ outfitName: 'Weekend Casual', status: 'Processing' }, 'This outfit'))
      .toBe('"Weekend Casual" has a try-on still running (Processing)');
  });

  it('keeps the fallback name and drops an absent status rather than inventing one', () => {
    expect(runningTryOnClause({ outfitName: null, status: null }, 'An outfit in this list'))
      .toBe('An outfit in this list has a try-on still running');
  });
});

describe('generationInProgressRefusal', () => {
  it('states that nothing was deleted and names what to wait for, for the item delete', () => {
    expect(generationInProgressRefusal(
      generationInProgress({
        status: 'Pending',
        blocking: [{ outfitId: 'outfit-1', outfitName: 'Weekend Casual', status: 'Pending' }],
      }),
      { fallbackName: 'An outfit in this list', target: 'item' },
    )).toBe(
      'Nothing was deleted: "Weekend Casual" has a try-on still running (Pending). Wait for it to finish, then delete this item.',
    );
  });

  it('addresses the outfit on the outfit delete', () => {
    expect(generationInProgressRefusal(
      generationInProgress({
        status: 'Processing',
        blocking: [{ outfitId: 'outfit-1', outfitName: 'Weekend Casual', status: 'Processing' }],
      }),
      { fallbackName: 'This outfit', target: 'outfit' },
    )).toBe(
      'Nothing was deleted: "Weekend Casual" has a try-on still running (Processing). Wait for it to finish, then delete the outfit.',
    );
  });
});
