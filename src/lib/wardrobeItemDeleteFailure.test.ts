import { describe, it, expect } from 'vitest';
import {
  describeWardrobeItemDeleteFailure,
  describeWardrobeItemLifecycleFailure,
  ITEM_ALREADY_GONE_MESSAGE,
  ITEM_CLEANUP_PENDING_MESSAGE,
} from './wardrobeItemDeleteFailure';

/**
 * The sentences the Storage Box delete paints, under the issue 332/334 contract.
 *
 * The retired `409 RESOURCE_REFERENCED` (an outfit still lists the item) is gone:
 * the delete cascades into those outfits instead of refusing. What remains is the
 * Storage Box gate, the in-flight refusal with its named blocker, the item's own
 * gallery proof, and the two "already settled" outcomes.
 */
function httpError(status: number, data?: unknown) {
  return { response: { status, data } };
}

describe('describeWardrobeItemDeleteFailure', () => {
  it('reports a request that never reached the server as a connection failure', () => {
    expect(describeWardrobeItemDeleteFailure(new Error('Network Error'))).toMatchObject({
      gone: false,
      cleanupPending: false,
      message: 'Could not reach the server. Check your connection and try again.',
    });
  });

  it('treats a 404 as already gone rather than a failure', () => {
    expect(describeWardrobeItemDeleteFailure(httpError(404))).toMatchObject({
      gone: true,
      message: ITEM_ALREADY_GONE_MESSAGE,
    });
  });

  it('says nothing beside the control for a 401, which the interceptor owns', () => {
    expect(describeWardrobeItemDeleteFailure(httpError(401)).message).toBeNull();
  });

  /** Issue 332 — deletion is reachable only from the Storage Box. */
  it('explains the Storage Box gate for ITEM_NOT_ARCHIVED', () => {
    const failure = describeWardrobeItemDeleteFailure(httpError(409, {
      error: 'ITEM_NOT_ARCHIVED',
      message: 'Clothing item is not in the Storage Box; archive it before deleting it',
      details: { itemId: 'item-1' },
    }));
    expect(failure.gone).toBe(false);
    expect(failure.message).toContain('Storage Box');
  });

  /** Issue 332 — a running try-on refuses the whole delete and names the outfit. */
  it('names the outfit whose try-on is still running for GENERATION_IN_PROGRESS', () => {
    const failure = describeWardrobeItemDeleteFailure(httpError(409, {
      error: 'GENERATION_IN_PROGRESS',
      message: 'VTO generation is still Pending and cannot be deleted',
      details: {
        generation_id: 'gen-1',
        status: 'Pending',
        blocking: [{
          outfitId: 'outfit-1',
          outfitName: 'Weekend Casual',
          generationId: 'gen-1',
          status: 'Pending',
        }],
      },
    }));
    expect(failure.gone).toBe(false);
    expect(failure.message).toContain('"Weekend Casual"');
    expect(failure.message).toContain('Pending');
    expect(failure.message).toContain('Wait for it to finish');
  });

  it('falls back to the status when the blocker names no outfit', () => {
    const failure = describeWardrobeItemDeleteFailure(httpError(409, {
      error: 'GENERATION_IN_PROGRESS',
      message: 'still running',
      details: { generation_id: 'gen-1', status: 'Processing' },
    }));
    expect(failure.message).toContain('Processing');
  });

  /** Issue 334 — the item's gallery proof is the only object proof left. */
  it('treats the item gallery 502 as a completed delete with cleanup pending', () => {
    const failure = describeWardrobeItemDeleteFailure(httpError(502, {
      error: 'OBJECT_DELETION_INCOMPLETE',
      message: 'The resource was deleted, but 1 stored object(s) could not be proven deleted',
      details: {
        manifest_id: 'manifest-1',
        manifest_ids: ['manifest-1'],
        retained_object_keys: ['wearable-items/user/item.jpg'],
      },
    }));
    expect(failure.cleanupPending).toBe(true);
    expect(failure.gone).toBe(false);
    expect(failure.message).toBe(ITEM_CLEANUP_PENDING_MESSAGE);
  });

  it('keeps a genuine server fault as a retryable sentence', () => {
    const failure = describeWardrobeItemDeleteFailure(httpError(503));
    expect(failure.cleanupPending).toBe(false);
    expect(failure.message).toContain('server error 503');
  });

  it('keeps the Service message for any other 4xx', () => {
    const failure = describeWardrobeItemDeleteFailure(httpError(403, { message: 'Not your item' }));
    expect(failure.message).toBe('Not your item');
  });
});

describe('describeWardrobeItemLifecycleFailure', () => {
  it('names the action that failed', () => {
    expect(describeWardrobeItemLifecycleFailure(httpError(500), 'archive')).toContain('archive');
    expect(describeWardrobeItemLifecycleFailure(httpError(500), 'restore')).toContain('restore');
  });

  it('treats a 404 as the item being gone', () => {
    expect(describeWardrobeItemLifecycleFailure(httpError(404), 'archive'))
      .toBe('This item is no longer in your wardrobe.');
  });

  it('says nothing for a 401, which the interceptor owns', () => {
    expect(describeWardrobeItemLifecycleFailure(httpError(401), 'archive')).toBe('');
  });
});
