// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../api/endpoints/wardrobe/wardrobe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/endpoints/wardrobe/wardrobe')>();
  return {
    ...actual,
    useGetWardrobe: vi.fn(),
    useGetWardrobeCategories: vi.fn(),
  };
});

vi.mock('../CachedImage', () => ({
  default: ({ src, cacheKey, alt, className, ...rest }: any) => (
    <img src={src} alt={alt} className={className} data-cache-key={cacheKey} {...rest} />
  ),
}));

import RoomWardrobeList from './RoomWardrobeList';
import { useGetWardrobe, useGetWardrobeCategories } from '../../api/endpoints/wardrobe/wardrobe';
import type { GetWardrobe200Item } from '../../api/model/getWardrobe200Item';

function wardrobeItem(overrides: Partial<GetWardrobe200Item> = {}): GetWardrobe200Item {
  return {
    id: 'item-1',
    ownerId: 'user-1',
    name: 'T-Shirt',
    images: [{ imageId: 'image-1', url: 'https://example.com/tshirt.jpg', view: null, isPrimary: true }],
    category: 'Top',
    taggingStatus: 'ready',
    taggingStateVersion: 1,
    taggingErrorCode: null,
    taggingErrorMessage: null,
    weatherTags: null,
    styleAttributes: { color: 'Blue', material: 'Cotton' },
    isPublic: false,
    imageEmbedding: null,
    createdAt: '2026-05-05T00:00:00.000Z',
    updatedAt: '2026-05-05T00:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

const onAdd = vi.fn();

describe('RoomWardrobeList', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(useGetWardrobe).mockReturnValue({
      data: [
        wardrobeItem(),
        wardrobeItem({ id: 'item-2', name: 'Jeans', category: 'Bottom', styleAttributes: { color: 'Black', material: 'Denim' } }),
      ],
      isLoading: false,
    } as never);
    vi.mocked(useGetWardrobeCategories).mockReturnValue({ data: { categories: ['Top', 'Bottom'] } } as never);
  });

  it('reads the room wardrobe with no filters at first', () => {
    render(<RoomWardrobeList onAdd={onAdd} />);

    expect(useGetWardrobe).toHaveBeenCalledWith({});
  });

  it('sends only the category, color and material parameters', () => {
    render(<RoomWardrobeList onAdd={onAdd} />);

    fireEvent.click(screen.getByRole('button', { name: 'Top' }));
    expect(useGetWardrobe).toHaveBeenLastCalledWith({ category: 'Top' });

    fireEvent.change(screen.getByLabelText('Color'), { target: { value: 'Blue' } });
    expect(useGetWardrobe).toHaveBeenLastCalledWith({ category: 'Top', color: 'Blue' });

    fireEvent.change(screen.getByLabelText('Material'), { target: { value: 'Cotton' } });
    const calls = vi.mocked(useGetWardrobe).mock.calls;
    const params = calls[calls.length - 1][0] as Record<string, unknown>;
    expect(params).toEqual({ category: 'Top', color: 'Blue', material: 'Cotton' });
    // The Storage Box's archive switch is never part of a room's picking read.
    expect(Object.keys(params).sort()).toEqual(['category', 'color', 'material']);
  });

  it('filters by search on the list it already has, with no new request', () => {
    render(<RoomWardrobeList onAdd={onAdd} />);

    fireEvent.change(screen.getByLabelText('Search wardrobe pieces'), { target: { value: 'jean' } });

    expect(screen.queryByRole('button', { name: 'Add T-Shirt to try on' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add Jeans to try on' })).toBeInTheDocument();
    // Every read the component asked for is unfiltered: the search adds neither a
    // request nor a parameter, which is what makes it a client-side filter.
    for (const [params] of vi.mocked(useGetWardrobe).mock.calls) {
      expect(params).toEqual({});
    }
    expect(vi.mocked(useGetWardrobe)).toHaveBeenLastCalledWith({});
  });

  it('names each card action Add … to try on and stages the piece', () => {
    render(<RoomWardrobeList onAdd={onAdd} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add T-Shirt to try on' }));

    expect(onAdd).toHaveBeenCalledWith('item-1');
  });

  it('never paints an archived piece, even from a stale cached list', () => {
    vi.mocked(useGetWardrobe).mockReturnValue({
      data: [wardrobeItem({ archivedAt: '2026-05-10T00:00:00.000Z' })],
      isLoading: false,
    } as never);

    render(<RoomWardrobeList onAdd={onAdd} />);

    // Absent, not marked: this is a picking surface, and To try on is where the
    // Archived badge belongs.
    expect(screen.queryByRole('button', { name: 'Add T-Shirt to try on' })).toBeNull();
    expect(screen.queryByText('Archived')).toBeNull();
    expect(screen.getByText('Your wardrobe is empty. Add pieces in the Wardrobe tab first.')).toBeInTheDocument();
  });
});
