import { describe, it, expect } from 'vitest';
import { applySettledVtoStatus } from './vtoHistoryStatus';
import type { VtoSettledStatus } from './vtoHistoryStatus';
import type { GetVtoGenerations200 } from '../api/model/getVtoGenerations200';
import type { GetVtoGenerations200GenerationsItem } from '../api/model/getVtoGenerations200GenerationsItem';
import type { GetVtoGenerations200GenerationsItemItemsItem } from '../api/model/getVtoGenerations200GenerationsItemItemsItem';

function item(id: string): GetVtoGenerations200GenerationsItemItemsItem {
  return { id, name: null, category: 'top', images: [] };
}

function row(
  overrides: Partial<GetVtoGenerations200GenerationsItem> & Pick<GetVtoGenerations200GenerationsItem, 'id'>,
): GetVtoGenerations200GenerationsItem {
  return {
    createdAt: '2026-11-01T00:00:00.000Z',
    status: 'Pending',
    imageId: null,
    url: null,
    rating: null,
    promptUsed: null,
    advancedSettings: null,
    items: [item('item-1')],
    ...overrides,
  };
}

function page(generations: GetVtoGenerations200GenerationsItem[]): GetVtoGenerations200 {
  return { generations, total: 3, page: 1, limit: 12, nextPage: null };
}

const settledComplete: VtoSettledStatus = {
  generation_id: 'generation-2',
  status: 'Complete',
  imageId: 'image-2',
  url: 'https://images.example.com/generation-2.jpg',
};

describe('applySettledVtoStatus', () => {
  it('updates only the matching row, at its own index, and keeps the siblings', () => {
    const first = row({ id: 'generation-1', status: 'Complete', imageId: 'image-1', url: 'https://images.example.com/1.jpg' });
    const second = row({ id: 'generation-2' });
    const third = row({ id: 'generation-3', status: 'Failed' });
    const fetched = page([first, second, third]);

    const derived = applySettledVtoStatus(fetched, settledComplete);

    expect(derived).not.toBe(fetched);
    expect(derived!.generations).not.toBe(fetched.generations);
    expect(derived!.generations.map((generation) => generation.id))
      .toEqual(['generation-1', 'generation-2', 'generation-3']);
    expect(derived!.generations[1]).toEqual({
      ...second,
      status: 'Complete',
      imageId: 'image-2',
      url: 'https://images.example.com/generation-2.jpg',
    });
    // The rows that were not corrected are the same objects, at the same index.
    expect(derived!.generations[0]).toBe(first);
    expect(derived!.generations[2]).toBe(third);
    // The page's own fields are the fetched ones.
    expect(derived!.total).toBe(3);
    expect(derived!.page).toBe(1);
    expect(derived!.limit).toBe(12);
    expect(derived!.nextPage).toBeNull();
  });

  it('applies a Failed status and the null image it carries', () => {
    const fetched = page([row({ id: 'generation-2' })]);

    const derived = applySettledVtoStatus(fetched, {
      generation_id: 'generation-2',
      status: 'Failed',
      imageId: null,
      url: null,
    });

    expect(derived!.generations[0]).toMatchObject({ status: 'Failed', imageId: null, url: null });
  });

  it('keeps createdAt, items, rating, promptUsed and advancedSettings from the page row', () => {
    const items = [item('item-a'), item('item-b')];
    const advancedSettings = { size: '1024x1024', seed: 42 };
    const second = row({
      id: 'generation-2',
      createdAt: '2026-10-02T03:04:05.000Z',
      items,
      rating: 4,
      promptUsed: 'a tailored prompt',
      advancedSettings,
    });
    const fetched = page([row({ id: 'generation-1' }), second]);

    const derived = applySettledVtoStatus(fetched, settledComplete);
    const updated = derived!.generations[1];

    expect(updated.createdAt).toBe('2026-10-02T03:04:05.000Z');
    expect(updated.items).toBe(items);
    expect(updated.rating).toBe(4);
    expect(updated.promptUsed).toBe('a tailored prompt');
    expect(updated.advancedSettings).toBe(advancedSettings);
    expect(updated.status).toBe('Complete');
    expect(updated.imageId).toBe('image-2');
    expect(updated.url).toBe('https://images.example.com/generation-2.jpg');
  });

  it('never inserts a row for a generation the page does not hold', () => {
    const fetched = page([row({ id: 'generation-1' }), row({ id: 'generation-3' })]);

    const derived = applySettledVtoStatus(fetched, settledComplete);

    expect(derived).toBe(fetched);
    expect(derived!.generations).toHaveLength(2);
    expect(derived!.generations.map((generation) => generation.id)).toEqual([
      'generation-1',
      'generation-3',
    ]);
  });

  it('returns the same page reference when the row already carries the settled values', () => {
    const alreadySettled = row({
      id: 'generation-2',
      status: 'Complete',
      imageId: 'image-2',
      url: 'https://images.example.com/generation-2.jpg',
    });
    const fetched = page([row({ id: 'generation-1' }), alreadySettled]);

    const derived = applySettledVtoStatus(fetched, settledComplete);

    expect(derived).toBe(fetched);
    expect(derived!.generations[1]).toBe(alreadySettled);
  });

  it('returns the input unchanged when it is not a page', () => {
    expect(applySettledVtoStatus(null, settledComplete)).toBeNull();
    expect(applySettledVtoStatus(undefined, settledComplete)).toBeUndefined();

    const notAPage = { total: 3 } as unknown as GetVtoGenerations200;
    expect(applySettledVtoStatus(notAPage, settledComplete)).toBe(notAPage);
  });

  it('returns the page unchanged while the page holds no terminal status', () => {
    const fetched = page([row({ id: 'generation-2' })]);

    expect(applySettledVtoStatus(fetched, null)).toBe(fetched);
  });
});
