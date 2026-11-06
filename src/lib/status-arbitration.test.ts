import { describe, expect, it } from 'vitest';
import {
  decideStatusVersion,
  mergeVtoStatus,
  mergeWardrobeListResponse,
  mergeWardrobeStatus,
  type VtoStatusSnapshot,
  type WardrobeStatusFrame,
  type WardrobeStatusItem,
} from './status-arbitration';

interface TestImage {
  imageId: string;
  url: string | null;
}

interface TestItem extends WardrobeStatusItem<TestImage> {
  id: string;
  name: string;
  category: string;
  taggingErrorCode: string | null;
}

function item(overrides: Partial<TestItem> = {}): TestItem {
  return {
    id: 'item-1',
    name: 'Coat',
    category: 'Outerwear',
    taggingStatus: 'processing',
    taggingStateVersion: 2,
    styleAttributes: null,
    weatherTags: null,
    taggingErrorMessage: null,
    taggingErrorCode: null,
    images: [{ imageId: 'image-1', url: 'https://example.com/old.jpg' }],
    ...overrides,
  };
}

function frame(overrides: Partial<WardrobeStatusFrame<TestImage>> = {}): WardrobeStatusFrame<TestImage> {
  return {
    item_id: 'item-1',
    tagging_status: 'ready',
    state_version: 3,
    style_attributes: { color: 'Blue' },
    weather_tags: ['Cold'],
    error_message: null,
    images: [{ imageId: 'image-1', url: 'https://example.com/new.jpg' }],
    ...overrides,
  };
}

describe('decideStatusVersion', () => {
  it('applies the first status when nothing is held', () => {
    expect(decideStatusVersion(1, undefined)).toBe('newer');
    expect(decideStatusVersion(1, null)).toBe('newer');
  });

  it('is strictly ordered: newer wins, equal is not newer, older loses', () => {
    expect(decideStatusVersion(4, 3)).toBe('newer');
    expect(decideStatusVersion(3, 3)).toBe('equal');
    expect(decideStatusVersion(2, 3)).toBe('older');
  });
});

describe('mergeWardrobeStatus', () => {
  it('replaces the frame-owned fields when the frame is newer', () => {
    const held = item();

    const merged = mergeWardrobeStatus(held, frame());

    expect(merged).not.toBe(held);
    expect(merged).toMatchObject({
      taggingStatus: 'ready',
      taggingStateVersion: 3,
      styleAttributes: { color: 'Blue' },
      weatherTags: ['Cold'],
      taggingErrorMessage: null,
      images: [{ imageId: 'image-1', url: 'https://example.com/new.jpg' }],
    });
    // Fields the frame never carries stay from the last list read.
    expect(merged).toMatchObject({ name: 'Coat', category: 'Outerwear', taggingErrorCode: null });
  });

  it('keeps every status field and replaces images only at an equal version', () => {
    const held = item({ taggingStatus: 'failed', taggingStateVersion: 3, taggingErrorMessage: 'boom' });

    const merged = mergeWardrobeStatus(held, frame({ state_version: 3, tagging_status: 'ready' }));

    expect(merged).not.toBe(held);
    expect(merged.taggingStatus).toBe('failed');
    expect(merged.taggingStateVersion).toBe(3);
    expect(merged.taggingErrorMessage).toBe('boom');
    expect(merged.images).toEqual([{ imageId: 'image-1', url: 'https://example.com/new.jpg' }]);
  });

  it('ignores an older frame and returns the held item itself', () => {
    const held = item({ taggingStatus: 'ready', taggingStateVersion: 4 });

    const merged = mergeWardrobeStatus(held, frame({ state_version: 3, tagging_status: 'processing' }));

    expect(merged).toBe(held);
    expect(merged.taggingStatus).toBe('ready');
    expect(merged.images).toEqual(held.images);
  });

  it('keeps a terminal status when a lower-version non-terminal frame arrives', () => {
    const held = item({ taggingStatus: 'failed', taggingStateVersion: 5 });

    const merged = mergeWardrobeStatus(held, frame({ state_version: 4, tagging_status: 'processing' }));

    expect(merged).toBe(held);
    expect(merged.taggingStatus).toBe('failed');
  });

  it('accepts a higher-version non-terminal status as a new lifecycle', () => {
    const held = item({ taggingStatus: 'ready', taggingStateVersion: 5 });

    const merged = mergeWardrobeStatus(held, frame({ state_version: 6, tagging_status: 'processing' }));

    expect(merged.taggingStatus).toBe('processing');
    expect(merged.taggingStateVersion).toBe(6);
  });
});

describe('mergeWardrobeListResponse', () => {
  it('keeps the newer cached item when a stale list response resolves', () => {
    const cached = item({ taggingStatus: 'ready', taggingStateVersion: 5, name: 'Fresh name' });
    const stale = item({ taggingStatus: 'processing', taggingStateVersion: 4, name: 'Stale name' });

    const merged = mergeWardrobeListResponse([cached], [stale]);

    expect(merged).toEqual([cached]);
  });

  it('takes the listed record at the cached version, refreshing fields a frame cannot carry', () => {
    const cached = item({ taggingStateVersion: 5, name: 'Old name' });
    const listed = item({ taggingStateVersion: 5, name: 'Renamed', category: 'Top' });

    const merged = mergeWardrobeListResponse([cached], [listed]);

    expect(merged).toEqual([listed]);
  });

  it('takes a newer listed record and drops items the response no longer has', () => {
    const cached = [item({ id: 'item-1', taggingStateVersion: 4 }), item({ id: 'gone' })];
    const listed = [item({ id: 'item-1', taggingStateVersion: 5 }), item({ id: 'item-2' })];

    const merged = mergeWardrobeListResponse(cached, listed);

    expect(merged.map((entry) => entry.id)).toEqual(['item-1', 'item-2']);
    expect(merged[0].taggingStateVersion).toBe(5);
  });

  it('takes the whole response when nothing is cached yet', () => {
    const listed = [item()];

    expect(mergeWardrobeListResponse(undefined, listed)).toEqual(listed);
  });
});

describe('mergeVtoStatus', () => {
  const processing: VtoStatusSnapshot & { status: string } = {
    status: 'Processing',
    state_version: 2,
    imageId: null,
    url: null,
  };
  const complete: VtoStatusSnapshot & { status: string } = {
    status: 'Complete',
    state_version: 3,
    imageId: 'image-9',
    url: 'https://example.com/result.jpg',
  };

  it('applies a newer status', () => {
    expect(mergeVtoStatus(processing, complete)).toEqual(complete);
  });

  it('keeps the terminal status when a slower poll returns an older one', () => {
    expect(mergeVtoStatus(complete, processing)).toEqual(complete);
  });

  it('replaces the image identity and URL only at an equal version', () => {
    const refreshed = { ...complete, url: 'https://example.com/resigned.jpg' };

    const merged = mergeVtoStatus(complete, refreshed);

    expect(merged.status).toBe('Complete');
    expect(merged.url).toBe('https://example.com/resigned.jpg');
  });

  it('applies the first status when nothing is cached', () => {
    expect(mergeVtoStatus(undefined, processing)).toEqual(processing);
  });
});
