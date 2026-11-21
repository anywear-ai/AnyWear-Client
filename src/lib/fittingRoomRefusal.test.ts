// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  describeRefusedItems,
  describeSelectionRefusal,
  readRefusedItemIds,
  refusedItemIds,
} from './fittingRoomRefusal';

function refusal(details: unknown, status = 400) {
  return { response: { status, data: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details } } };
}

describe('readRefusedItemIds', () => {
  it('reads every bucket the contract names', () => {
    expect(readRefusedItemIds(refusal({
      archivedItemIds: ['item-a'],
      missingItemIds: ['item-b'],
      imageLessItemIds: ['item-c'],
      duplicateItemIds: ['item-d'],
    }))).toEqual({
      archivedItemIds: ['item-a'],
      missingItemIds: ['item-b'],
      imageLessItemIds: ['item-c'],
      duplicateItemIds: ['item-d'],
    });
  });

  it('returns no ids for a body it cannot read, so the caller reports the Service sentence', () => {
    expect(readRefusedItemIds(undefined)).toEqual({
      archivedItemIds: [], missingItemIds: [], imageLessItemIds: [], duplicateItemIds: [],
    });
    // A Zod `details` array is not a bucket body: it names keys, not members.
    expect(readRefusedItemIds(refusal([{ path: '', message: 'Unrecognized key' }])))
      .toEqual({ archivedItemIds: [], missingItemIds: [], imageLessItemIds: [], duplicateItemIds: [] });
    expect(readRefusedItemIds({ response: { status: 500 } }))
      .toEqual({ archivedItemIds: [], missingItemIds: [], imageLessItemIds: [], duplicateItemIds: [] });
  });

  it('drops entries that are not ids', () => {
    expect(readRefusedItemIds(refusal({ archivedItemIds: ['item-a', 7, '', null] })).archivedItemIds)
      .toEqual(['item-a']);
  });
});

describe('refusedItemIds', () => {
  it('unions the buckets without duplicates', () => {
    expect(refusedItemIds({
      archivedItemIds: ['a', 'b'],
      missingItemIds: ['b', 'c'],
      imageLessItemIds: [],
      duplicateItemIds: ['c'],
    })).toEqual(['a', 'b', 'c']);
  });
});

describe('describeSelectionRefusal', () => {
  it('names each reason and asks the user to try again', () => {
    const { untickIds, message } = describeSelectionRefusal(refusal({
      archivedItemIds: ['archived-1'],
      imageLessItemIds: ['no-image-1', 'no-image-2'],
    }));

    expect(untickIds).toEqual(['archived-1', 'no-image-1', 'no-image-2']);
    expect(message).toContain('Nothing was sent');
    expect(message).toContain('1 piece is in the Storage Box');
    expect(message).toContain('2 pieces have no image yet');
    expect(message).toContain('try again');
  });

  it('uses the singular for one archived member', () => {
    expect(describeRefusedItems({
      archivedItemIds: ['a'], missingItemIds: [], imageLessItemIds: [], duplicateItemIds: [],
    })).toBe('Nothing was sent: 1 piece is in the Storage Box. The named pieces were removed from your selection — check To try on and try again.');
  });

  it('keeps the Service sentence when no ids are named', () => {
    const { untickIds, message } = describeSelectionRefusal({
      response: { status: 400, data: { message: 'Six pieces are more than one try-on accepts.' } },
    });

    expect(untickIds).toEqual([]);
    expect(message).toBe('Six pieces are more than one try-on accepts.');
  });

  it('falls back to a sentence when nothing can be read', () => {
    expect(describeSelectionRefusal(undefined).message)
      .toBe('That selection could not be used. Check To try on and try again.');
  });
});
