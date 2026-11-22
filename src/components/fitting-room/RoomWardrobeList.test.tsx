// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

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

const onToggle = vi.fn();

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
    render(<RoomWardrobeList onToggle={onToggle} stagedIds={[]} />);

    expect(useGetWardrobe).toHaveBeenCalledWith({});
  });

  it('sends only the category, color and material parameters', () => {
    render(<RoomWardrobeList onToggle={onToggle} stagedIds={[]} />);

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
    render(<RoomWardrobeList onToggle={onToggle} stagedIds={[]} />);

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

  it('puts every card in one group named Wardrobe pieces', () => {
    render(<RoomWardrobeList onToggle={onToggle} stagedIds={[]} />);

    const group = screen.getByRole('group', { name: 'Wardrobe pieces' });
    expect(within(group).getByRole('button', { name: 'Add T-Shirt to try on' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Add Jeans to try on' })).toBeInTheDocument();
    // The grid keeps its test id, so the browser suite's layout check still reads it.
    expect(screen.getByTestId('room-wardrobe-grid')).toBe(group);
  });

  it('makes the whole card one unstaged toggle button holding the image, name and tags', () => {
    render(<RoomWardrobeList onToggle={onToggle} stagedIds={[]} />);

    const tile = screen.getByRole('button', { name: 'Add T-Shirt to try on' });
    expect(tile.tagName).toBe('BUTTON');
    expect(tile).toHaveAttribute('type', 'button');
    expect(tile).toHaveAttribute('aria-pressed', 'false');
    // The image, the name and the tag line are inside the control, not beside it.
    expect(tile.querySelector('img')).not.toBeNull();
    expect(tile).toHaveTextContent('T-Shirt');
    expect(tile).toHaveTextContent('Top • Blue • Cotton');
    // The accessible name already carries the label, so the image is decoration.
    expect(tile.querySelector('img')).toHaveAttribute('alt', '');
    expect(screen.queryByText('Selected')).toBeNull();
  });

  it('states a staged card with aria-pressed, the Remove name and a visible Selected chip', () => {
    render(<RoomWardrobeList onToggle={onToggle} stagedIds={['item-1']} />);

    const staged = screen.getByRole('button', { name: 'Remove T-Shirt from try on' });
    expect(staged).toHaveAttribute('aria-pressed', 'true');
    expect(staged).toHaveClass('border-indigo-600', 'ring-1', 'ring-indigo-600');
    // Colour is never the only carrier: the chip says so in words.
    expect(within(staged).getByText('Selected')).toBeInTheDocument();
    // The other card is untouched by the staged set.
    const unstaged = screen.getByRole('button', { name: 'Add Jeans to try on' });
    expect(unstaged).toHaveAttribute('aria-pressed', 'false');
    expect(within(unstaged).queryByText('Selected')).toBeNull();
  });

  it('hands a tile activation to onToggle, whichever state the tile is in', () => {
    const { unmount } = render(<RoomWardrobeList onToggle={onToggle} stagedIds={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add T-Shirt to try on' }));
    expect(onToggle).toHaveBeenCalledWith('item-1');
    unmount();

    onToggle.mockClear();
    render(<RoomWardrobeList onToggle={onToggle} stagedIds={['item-1']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove T-Shirt from try on' }));
    expect(onToggle).toHaveBeenCalledWith('item-1');
  });

  it('holds every tile while a staging or removal request is out', () => {
    render(<RoomWardrobeList onToggle={onToggle} stagedIds={[]} isMutating />);

    expect(screen.getByRole('button', { name: 'Add T-Shirt to try on' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add Jeans to try on' })).toBeDisabled();
  });

  it('never paints an archived piece, even from a stale cached list', () => {
    vi.mocked(useGetWardrobe).mockReturnValue({
      data: [wardrobeItem({ archivedAt: '2026-05-10T00:00:00.000Z' })],
      isLoading: false,
    } as never);

    render(<RoomWardrobeList onToggle={onToggle} stagedIds={[]} />);

    // Absent, not marked: this is a picking surface, and To try on is where the
    // Archived badge belongs.
    expect(screen.queryByRole('button', { name: 'Add T-Shirt to try on' })).toBeNull();
    expect(screen.queryByText('Archived')).toBeNull();
    expect(screen.getByText('Your wardrobe is empty. Add pieces in the Wardrobe tab first.')).toBeInTheDocument();
  });
});
