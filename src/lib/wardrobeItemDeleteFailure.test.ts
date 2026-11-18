import { describe, expect, it } from 'vitest';
import {
  describeWardrobeItemDeleteFailure,
  ITEM_ALREADY_GONE_MESSAGE,
} from './wardrobeItemDeleteFailure';

/** An Axios rejection: the status and body live on `error.response`. */
function rejection(status: number, data?: unknown) {
  return { isAxiosError: true, response: { status, data } };
}

/** The Service's `DELETE /wardrobe/items/{id}` 409 body. */
function referencedBody(dependentResources: { resource: string; count?: number }[], hint?: string) {
  return {
    error: 'RESOURCE_REFERENCED',
    message: 'The wardrobe item is still referenced by other resources',
    details: {
      reason: 'DEPENDENT_RESOURCES_EXIST',
      dependent_resources: dependentResources,
      action: 'delete_dependents_first',
      hint: hint ?? 'Remove the item from the outfit that lists it, then delete it',
    },
  };
}

// S1: the Service reported exactly one outfit.
const S1 =
  'Nothing was deleted: this item is still in 1 outfit. Remove it from that outfit, or delete the outfit. An outfit cannot be saved with no items, so if this is its only item, delete it.';
// S2: the Service reported more than one outfit; the number is the Service's.
const S2 =
  'Nothing was deleted: this item is still in 3 outfits. Remove it from those outfits, or delete them. An outfit cannot be saved with no items, so an outfit holding only this item has to be deleted.';
// S3: an outfit dependent with no count.
const S3 =
  'Nothing was deleted: this item is still in one or more outfits. Remove it from those outfits, or delete them. An outfit cannot be saved with no items, so an outfit holding only this item has to be deleted.';

describe('describeWardrobeItemDeleteFailure', () => {
  it('states the one-outfit sentence with the count the Service reports', () => {
    expect(
      describeWardrobeItemDeleteFailure(rejection(409, referencedBody([{ resource: 'outfit', count: 1 }]))),
    ).toEqual({ message: S1, gone: false });
  });

  it('states the plural sentence with the Service count for more than one outfit', () => {
    expect(
      describeWardrobeItemDeleteFailure(rejection(409, referencedBody([{ resource: 'outfit', count: 3 }]))),
    ).toEqual({ message: S2, gone: false });
  });

  it('states the count-less sentence when the Service supplied no count', () => {
    expect(
      describeWardrobeItemDeleteFailure(rejection(409, referencedBody([{ resource: 'outfit' }]))),
    ).toEqual({ message: S3, gone: false });

    // A zero or negative count is not a number of outfits that can hold the item,
    // so it reads count-less rather than claiming "0 outfits".
    expect(
      describeWardrobeItemDeleteFailure(rejection(409, referencedBody([{ resource: 'outfit', count: 0 }]))),
    ).toEqual({ message: S3, gone: false });
  });

  it('states that nothing was deleted and both remedies in every outfit sentence', () => {
    for (const message of [S1, S2, S3]) {
      expect(message.startsWith('Nothing was deleted:')).toBe(true);
      // The two remedies, in the order the sentence gives them.
      expect(message).toContain('Remove it from');
      expect(message).toContain('or delete the');
      // The at-least-one-item constraint that makes deleting the outfit necessary.
      expect(message).toContain('An outfit cannot be saved with no items');
    }
    // Only the singular sentence can promise the outfit may be emptied first.
    expect(S1).toContain('if this is its only item, delete it.');
    expect(S2).toContain('an outfit holding only this item has to be deleted.');
    expect(S3).toContain('an outfit holding only this item has to be deleted.');
  });

  it('keeps the Service hint verbatim for a 409 that names no outfit', () => {
    const body = referencedBody([{ resource: 'wardrobe_item_tag', count: 2 }], 'Delete the tag that references this item first');

    const failure = describeWardrobeItemDeleteFailure(rejection(409, body));

    expect(failure).toEqual({ message: 'Delete the tag that references this item first', gone: false });
    // The fallback boundary: nothing invents an outfit the Service did not name.
    expect(failure.message).not.toContain('outfit');
  });

  it('states the generic dependent sentence for a 409 with no hint and no outfit', () => {
    const noHint = {
      error: 'RESOURCE_REFERENCED',
      message: 'The wardrobe item is still referenced by other resources',
      details: { reason: 'DEPENDENT_RESOURCES_EXIST', dependent_resources: [], action: 'delete_dependents_first' },
    };
    expect(describeWardrobeItemDeleteFailure(rejection(409, noHint))).toEqual({
      message: 'Something still depends on this item, so it was not deleted.',
      gone: false,
    });

    // A 409 with no `details` at all supplies no hint either.
    expect(describeWardrobeItemDeleteFailure(rejection(409, { error: 'RESOURCE_REFERENCED', message: 'Still referenced' }))).toEqual({
      message: 'Something still depends on this item, so it was not deleted.',
      gone: false,
    });
  });

  it('treats a 404 as already gone and states the page sentence', () => {
    expect(describeWardrobeItemDeleteFailure(rejection(404, { error: 'NOT_FOUND', message: 'Wardrobe item not found' }))).toEqual({
      message: ITEM_ALREADY_GONE_MESSAGE,
      gone: true,
    });
    expect(ITEM_ALREADY_GONE_MESSAGE).toBe(
      'This item is no longer in your wardrobe, so it was removed from this list.',
    );
  });

  it('reports a server error with its real status', () => {
    expect(describeWardrobeItemDeleteFailure(rejection(500, { message: 'Internal Server Error' }))).toEqual({
      message: 'Could not delete this item (server error 500). Try again.',
      gone: false,
    });
    expect(describeWardrobeItemDeleteFailure(rejection(503, undefined))).toEqual({
      message: 'Could not delete this item (server error 503). Try again.',
      gone: false,
    });
  });

  it('reports a request that never reached the server as a connection failure', () => {
    // Axios records the attempted request and no response for a network failure.
    expect(describeWardrobeItemDeleteFailure({ isAxiosError: true, request: {}, message: 'Network Error' })).toEqual({
      message: 'Could not reach the server. Check your connection and try again.',
      gone: false,
    });
  });

  it('paints nothing for a 401, which the interceptor is redirecting on', () => {
    // The page is leaving for /login; a sentence beside the control would be an
    // error beside a redirect the person cannot act on.
    expect(describeWardrobeItemDeleteFailure(rejection(401, { error: 'UNAUTHORIZED', message: 'Unauthorized' }))).toEqual({
      message: null,
      gone: false,
    });
  });

  it('uses the Service message for the remaining refused statuses', () => {
    expect(describeWardrobeItemDeleteFailure(rejection(400, { message: 'Invalid item id' }))).toEqual({
      message: 'Invalid item id',
      gone: false,
    });
    expect(describeWardrobeItemDeleteFailure(rejection(403, { message: 'Not your item' }))).toEqual({
      message: 'Not your item',
      gone: false,
    });
    // A body without a message keeps the Client's generic refusal sentence.
    expect(describeWardrobeItemDeleteFailure({ response: { status: 400 }, message: '' })).toEqual({
      message: 'Could not delete this item.',
      gone: false,
    });
  });

  it('reports a value that is not an error with the generic refusal sentence', () => {
    expect(describeWardrobeItemDeleteFailure('failure')).toEqual({
      message: 'Could not delete this item.',
      gone: false,
    });
    expect(describeWardrobeItemDeleteFailure(null)).toEqual({
      message: 'Could not delete this item.',
      gone: false,
    });
  });

  it('never describes an outfit conflict for the fallback boundary statuses', () => {
    // #330.3: a 404, a 5xx, a transport failure and a 409 naming no outfit each
    // render a distinct sentence that names no outfit and points at no remedy.
    const boundary = [
      describeWardrobeItemDeleteFailure(rejection(404, {})).message,
      describeWardrobeItemDeleteFailure(rejection(503, {})).message,
      describeWardrobeItemDeleteFailure({ isAxiosError: true, request: {} }).message,
      describeWardrobeItemDeleteFailure(
        rejection(409, referencedBody(
          [{ resource: 'outfit_generation', count: 2 }],
          'Delete the try-on that references this item, then delete it.',
        )),
      ).message,
    ];

    expect(new Set(boundary).size).toBe(boundary.length);
    for (const message of boundary) {
      expect(message).not.toBeNull();
      expect(message).not.toContain('outfit');
      expect(message).not.toContain('Nothing was deleted');
    }
  });
});
