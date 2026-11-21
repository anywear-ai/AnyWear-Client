// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

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

  it('names each control from the piece it acts on', () => {
    render(<ToTryOnList items={[staged()]} selectedIds={[]} onToggle={onToggle} onRemove={onRemove} />);

    expect(screen.getByRole('button', { name: 'Select T-Shirt' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Select T-Shirt' }));
    expect(onToggle).toHaveBeenCalledWith('item-1');

    fireEvent.click(screen.getByRole('button', { name: 'Remove T-Shirt from try on' }));
    expect(onRemove).toHaveBeenCalledWith('item-1');
  });

  it('reads Deselect on a ticked row', () => {
    render(<ToTryOnList items={[staged()]} selectedIds={['item-1']} onToggle={onToggle} onRemove={onRemove} />);

    expect(screen.getByRole('button', { name: 'Deselect T-Shirt' })).toHaveAttribute('aria-pressed', 'true');
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
    // It is still removable: the staging row is a record, not a selection.
    expect(screen.getByRole('button', { name: 'Remove T-Shirt from try on' })).toBeEnabled();
  });

  it('says what to do when nothing is staged', () => {
    render(<ToTryOnList items={[]} selectedIds={[]} onToggle={onToggle} onRemove={onRemove} />);

    expect(screen.getByText(/Nothing is staged yet/)).toBeInTheDocument();
  });
});
