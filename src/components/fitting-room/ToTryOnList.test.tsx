// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../CachedImage', () => ({
  default: ({ src, cacheKey, alt, className, ...rest }: any) => (
    <img src={src} alt={alt} className={className} data-cache-key={cacheKey} {...rest} />
  ),
}));

import ToTryOnList from './ToTryOnList';
import type { GetFittingRoomsFittingRoomId200ItemsItem } from '../../api/model/getFittingRoomsFittingRoomId200ItemsItem';

function staged(overrides: Partial<GetFittingRoomsFittingRoomId200ItemsItem> = {}): GetFittingRoomsFittingRoomId200ItemsItem {
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
    isPublic: false,
    imageEmbedding: null,
    createdAt: '2026-05-05T00:00:00.000Z',
    updatedAt: '2026-05-05T00:00:00.000Z',
    archivedAt: null,
    addedAt: '2026-05-06T00:00:00.000Z',
    ...overrides,
  };
}

const onToggle = vi.fn();
const onRemove = vi.fn();

describe('ToTryOnList', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('counts the ticked subset out of five, not the staged list', () => {
    const items = Array.from({ length: 7 }, (_, index) => staged({ id: `item-${index}`, name: `Piece ${index}` }));
    render(<ToTryOnList items={items} selectedIds={['item-1', 'item-2']} onToggle={onToggle} onRemove={onRemove} />);

    expect(screen.getAllByTestId('to-try-on-row')).toHaveLength(7);
    expect(screen.getByTestId('to-try-on-counter')).toHaveTextContent('2 / 5');
  });

  it('puts the staged rows in one toggle group named Staged pieces, never a radio group', () => {
    const items = [staged(), staged({ id: 'item-2', name: 'Jeans' })];
    render(<ToTryOnList items={items} selectedIds={[]} onToggle={onToggle} onRemove={onRemove} />);

    const group = screen.getByRole('group', { name: 'Staged pieces' });
    expect(within(group).getAllByTestId('to-try-on-row')).toHaveLength(2);
    // The choice is up to five of an unlimited staged set: a toggle button group,
    // not the single-choice radio form the base-photo picker's shape could imply.
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('makes the tile one toggle button holding the image and the name', () => {
    render(<ToTryOnList items={[staged()]} selectedIds={[]} onToggle={onToggle} onRemove={onRemove} />);

    const tile = screen.getByRole('button', { name: 'Select T-Shirt' });
    expect(tile).toHaveAttribute('aria-pressed', 'false');
    expect(tile.querySelector('img')).not.toBeNull();
    expect(tile.querySelector('img')).toHaveAttribute('alt', '');
    expect(tile).toHaveTextContent('T-Shirt');
    expect(within(tile).queryByText('Selected')).toBeNull();

    fireEvent.click(tile);
    expect(onToggle).toHaveBeenCalledWith('item-1');
  });

  it('states a chosen tile with aria-pressed, the Selected name and the chip', () => {
    render(<ToTryOnList items={[staged()]} selectedIds={['item-1']} onToggle={onToggle} onRemove={onRemove} />);

    const tile = screen.getByRole('button', { name: 'Selected T-Shirt' });
    expect(tile).toHaveAttribute('aria-pressed', 'true');
    expect(tile).toHaveClass('border-indigo-600', 'ring-1', 'ring-indigo-600');
    expect(within(tile).getByText('Selected')).toBeInTheDocument();
    // No text Select/Deselect control survives beside the row.
    expect(screen.queryByRole('button', { name: 'Deselect T-Shirt' })).toBeNull();
    expect(screen.queryByText('Select')).toBeNull();
    expect(screen.queryByText('Deselect')).toBeNull();
  });

  it('keeps Remove a separate button that is not a toggle and removes the row', () => {
    render(<ToTryOnList items={[staged()]} selectedIds={['item-1']} onToggle={onToggle} onRemove={onRemove} />);

    const remove = screen.getByRole('button', { name: 'Remove T-Shirt from try on' });
    expect(remove).not.toHaveAttribute('aria-pressed');
    // It sits beside the tile, not inside it: un-choosing and removing stay two acts.
    expect(remove.closest('button')).toBe(remove);
    expect(within(screen.getByRole('button', { name: 'Selected T-Shirt' })).queryByRole('button')).toBeNull();

    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledWith('item-1');
  });

  it('keeps an archived member visible with the Archived badge and no way to tick it', () => {
    render(
      <ToTryOnList
        items={[staged({ archivedAt: '2026-05-10T00:00:00.000Z' })]}
        selectedIds={[]}
        onToggle={onToggle}
        onRemove={onRemove}
      />,
    );

    expect(screen.getByTestId('to-try-on-archived')).toHaveTextContent('Archived');
    expect(screen.getByRole('button', { name: 'Select T-Shirt' })).toBeDisabled();
    expect(screen.getByText('Restore this piece in the Storage Box to try it on again.')).toBeInTheDocument();
    // It is still removable: the staging row is a record, not a selection.
    expect(screen.getByRole('button', { name: 'Remove T-Shirt from try on' })).toBeEnabled();
  });

  it('says what to do when nothing is staged', () => {
    render(<ToTryOnList items={[]} selectedIds={[]} onToggle={onToggle} onRemove={onRemove} />);

    expect(screen.getByText('Nothing is staged yet. Click pieces in Wardrobe above to keep them here for this room.')).toBeInTheDocument();
  });
});
