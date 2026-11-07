// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import CreateOutfitModal from '../../pages/wardrobe/CreateOutfitModal';

const mockItems = [
  { id: 'item-1', name: 'T-Shirt', category: 'Top', images: [] },
  { id: 'item-2', name: 'Jeans', category: 'Bottom', images: [] },
  { id: 'item-3', name: null, category: 'Shoes', images: [] },
];

vi.mock('../../api/endpoints/outfits/outfits', () => ({
  usePostOutfits: vi.fn(),
  usePatchOutfitsId: vi.fn(),
  useDeleteOutfitsId: vi.fn(),
}));

vi.mock('../../api/endpoints/wardrobe/wardrobe', () => ({
  useGetWardrobe: vi.fn(),
}));

import { usePostOutfits, usePatchOutfitsId, useDeleteOutfitsId } from '../../api/endpoints/outfits/outfits';
import { useGetWardrobe } from '../../api/endpoints/wardrobe/wardrobe';

function setupMocks(items: typeof mockItems = mockItems) {
  vi.mocked(useGetWardrobe).mockReturnValue({
    data: items,
    isLoading: false,
    isError: false,
  } as any);
  vi.mocked(usePostOutfits).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as any);
  vi.mocked(usePatchOutfitsId).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as any);
  vi.mocked(useDeleteOutfitsId).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as any);
}

const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** The tokens jsdom cannot paint: both the width and the colour must be authored. */
function expectRingTokens(element: HTMLElement, state = 'focus:') {
  const tokens = element.className.split(/\s+/);
  expect(tokens, `${element.tagName} is missing ${state}ring-2`).toContain(`${state}ring-2`);
  expect(tokens, `${element.tagName} is missing ${state}ring-indigo-500`).toContain(`${state}ring-indigo-500`);
}

function expectEveryStopRings(dialog: HTMLElement) {
  const stops = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((element) => !element.classList.contains('hidden'));
  expect(stops.length).toBeGreaterThan(0);

  for (const stop of stops) {
    expectRingTokens(stop);
  }
}

describe('CreateOutfitModal', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onSuccess: vi.fn(),
  };

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    document.body.style.overflow = '';
  });

  it('renders nothing when isOpen is false', () => {
    setupMocks();
    const { container } = render(<CreateOutfitModal {...defaultProps} isOpen={false} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders modal title when open', () => {
    setupMocks();
    render(<CreateOutfitModal {...defaultProps} />);
    expect(screen.getByRole('heading', { name: 'Create Outfit' })).toBeDefined();
  });

  it('shows name input field', () => {
    setupMocks();
    render(<CreateOutfitModal {...defaultProps} />);

    const input = screen.getByPlaceholderText('e.g. Weekend Casual');
    expect(input).toBeDefined();
    expect(input).toHaveAttribute('maxLength', '200');
  });

  it('shows wardrobe items with names', () => {
    setupMocks();
    render(<CreateOutfitModal {...defaultProps} />);

    expect(screen.getByText('T-Shirt')).toBeDefined();
    expect(screen.getByText('Jeans')).toBeDefined();
    expect(screen.getByText('Shoes')).toBeDefined();
  });

  it('shows empty state when no wardrobe items', () => {
    vi.mocked(useGetWardrobe).mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    } as any);
    vi.mocked(usePostOutfits).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as any);

    render(<CreateOutfitModal {...defaultProps} />);

    expect(screen.getByText('No items in wardrobe yet.')).toBeDefined();
  });

  it('toggles item selection on click', () => {
    setupMocks();
    render(<CreateOutfitModal {...defaultProps} />);

    const tshirtButton = screen.getByText('T-Shirt');
    fireEvent.click(tshirtButton);

    // The selection count should update
    expect(screen.getByText(/1 selected/)).toBeDefined();

    // Click again to deselect
    fireEvent.click(tshirtButton);
    expect(screen.getByText(/0 selected/)).toBeDefined();
  });

  it('selects multiple items', () => {
    setupMocks();
    render(<CreateOutfitModal {...defaultProps} />);

    fireEvent.click(screen.getByText('T-Shirt'));
    fireEvent.click(screen.getByText('Jeans'));

    expect(screen.getByText(/2 selected/)).toBeDefined();
  });

  it('disables create and does not submit when no items are selected', () => {
    setupMocks();
    const mutate = vi.fn();
    vi.mocked(usePostOutfits).mockReturnValue({ mutate, isPending: false } as any);
    render(<CreateOutfitModal {...defaultProps} />);

    const createButton = screen.getByRole('button', { name: 'Create Outfit' });
    expect(createButton).toBeDisabled();
    fireEvent.click(createButton);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('enables create button when items selected', () => {
    setupMocks();
    render(<CreateOutfitModal {...defaultProps} />);

    fireEvent.click(screen.getByText('T-Shirt'));

    const createButton = screen.getByRole('button', { name: 'Create Outfit' });
    expect(createButton).not.toBeDisabled();
  });

  it('shows creating state when pending', () => {
    setupMocks();
    vi.mocked(usePostOutfits).mockReturnValue({
      mutate: vi.fn(),
      isPending: true,
    } as any);

    render(<CreateOutfitModal {...defaultProps} />);

    expect(screen.getByText('Creating...')).toBeDefined();
  });

  it('calls onClose when cancel button clicked', () => {
    const onClose = vi.fn();
    setupMocks();
    render(<CreateOutfitModal {...defaultProps} onClose={onClose} />);

    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop clicked', () => {
    const onClose = vi.fn();
    setupMocks();
    render(<CreateOutfitModal {...defaultProps} onClose={onClose} />);

    // The backdrop is the dialog panel's immediately preceding sibling; the
    // test asserts the dismissal, not the styling class that produced it.
    const backdrop = screen.getByRole('dialog').previousElementSibling;
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls mutate with correct data on create', () => {
    const mutate = vi.fn();
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    setupMocks();
    vi.mocked(usePostOutfits).mockReturnValue({
      mutate,
      isPending: false,
    } as any);

    render(<CreateOutfitModal {...defaultProps} onSuccess={onSuccess} onClose={onClose} />);

    fireEvent.click(screen.getByText('T-Shirt'));

    // Set a name
    const nameInput = screen.getByPlaceholderText('e.g. Weekend Casual');
    fireEvent.change(nameInput, { target: { value: 'My Outfit' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Outfit' }));

    expect(mutate).toHaveBeenCalledWith(
      { data: { name: 'My Outfit', wearable_item_ids: ['item-1'] } },
      expect.objectContaining({
        onSuccess: expect.any(Function),
      }),
    );
  });

  it('omits the name key from the wire body when the name field is left untouched', () => {
    const mutate = vi.fn();
    setupMocks();
    vi.mocked(usePostOutfits).mockReturnValue({
      mutate,
      isPending: false,
    } as any);

    render(<CreateOutfitModal {...defaultProps} />);

    fireEvent.click(screen.getByText('T-Shirt'));
    fireEvent.click(screen.getByRole('button', { name: 'Create Outfit' }));

    const body = mutate.mock.calls[0][0].data;
    expect(body.name).toBeUndefined();
    // The body the mutation holds still names the field; the serialized request
    // is what reaches the Service, and JSON.stringify drops an undefined value.
    expect(JSON.stringify(body)).toBe('{"wearable_item_ids":["item-1"]}');
    expect(JSON.stringify(body)).not.toContain('"name"');
  });

  it('strips whitespace from name before creating', () => {
    const mutate = vi.fn();
    setupMocks();
    vi.mocked(usePostOutfits).mockReturnValue({
      mutate,
      isPending: false,
    } as any);

    render(<CreateOutfitModal {...defaultProps} />);

    fireEvent.click(screen.getByText('T-Shirt'));

    const nameInput = screen.getByPlaceholderText('e.g. Weekend Casual');
    fireEvent.change(nameInput, { target: { value: '   ' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Outfit' }));

    // Whitespace-only name should become undefined
    expect(mutate).toHaveBeenCalledWith(
      { data: { name: undefined, wearable_item_ids: ['item-1'] } },
      expect.any(Object),
    );
  });

  // ---- Edit Mode Tests ----

  const editOutfit = {
    id: 'outfit-1',
    userId: 'user-1',
    name: 'Weekend Casual',
    wearableItems: [
      { id: 'item-1', name: 'T-Shirt', category: 'Top', images: [] },
      { id: 'item-2', name: 'Jeans', category: 'Bottom', images: [] },
    ],
    createdAt: '2024-01-01T00:00:00Z',
  };

  it('renders edit mode title when outfit prop is provided', () => {
    setupMocks();
    render(<CreateOutfitModal {...defaultProps} outfit={editOutfit} />);
    expect(screen.getByRole('heading', { name: 'Edit Outfit' })).toBeDefined();
  });

  it('pre-fills name field from outfit prop', () => {
    setupMocks();
    render(<CreateOutfitModal {...defaultProps} outfit={editOutfit} />);

    const nameInput = screen.getByPlaceholderText('e.g. Weekend Casual') as HTMLInputElement;
    expect(nameInput.value).toBe('Weekend Casual');
  });

  it('pre-selects items from outfit prop', () => {
    setupMocks();
    render(<CreateOutfitModal {...defaultProps} outfit={editOutfit} />);

    // Both items should be pre-selected
    expect(screen.getByText(/2 selected/)).toBeDefined();
  });

  it('shows Save Changes button in edit mode', () => {
    setupMocks();
    render(<CreateOutfitModal {...defaultProps} outfit={editOutfit} />);
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDefined();
  });

  it('calls usePatchOutfitsId on save in edit mode', () => {
    const mutate = vi.fn();
    setupMocks();
    vi.mocked(usePatchOutfitsId).mockReturnValue({
      mutate,
      isPending: false,
    } as any);

    render(<CreateOutfitModal {...defaultProps} outfit={editOutfit} />);

    const nameInput = screen.getByPlaceholderText('e.g. Weekend Casual');
    fireEvent.change(nameInput, { target: { value: 'Updated Outfit' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(mutate).toHaveBeenCalledWith(
      { id: 'outfit-1', data: { name: 'Updated Outfit', wearable_item_ids: ['item-1', 'item-2'] } },
      expect.objectContaining({
        onSuccess: expect.any(Function),
      }),
    );
  });

  it('shows Delete Outfit button in edit mode', () => {
    setupMocks();
    render(<CreateOutfitModal {...defaultProps} outfit={editOutfit} />);
    expect(screen.getByRole('button', { name: 'Delete Outfit' })).toBeDefined();
  });

  it('shows delete confirmation when Delete Outfit is clicked', () => {
    setupMocks();
    render(<CreateOutfitModal {...defaultProps} outfit={editOutfit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Outfit' }));

    expect(screen.getByText('Delete this outfit? This cannot be undone.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDefined();
    // Two Cancel buttons: one in confirmation inline, one in footer; get them all
    const cancelButtons = screen.getAllByRole('button', { name: 'Cancel' });
    expect(cancelButtons.length).toBeGreaterThanOrEqual(2);
  });

  it('cancels delete confirmation when Cancel is clicked', () => {
    setupMocks();
    render(<CreateOutfitModal {...defaultProps} outfit={editOutfit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Outfit' }));
    // Click the first Cancel button (inline deletion confirmation Cancel)
    const cancelButtons = screen.getAllByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelButtons[0]);

    // Back to delete button visible, confirmation text gone
    expect(screen.getByRole('button', { name: 'Delete Outfit' })).toBeDefined();
    expect(screen.queryByText('Delete this outfit? This cannot be undone.')).toBeNull();
  });

  it('calls useDeleteOutfitsId on confirm delete', () => {
    const mutate = vi.fn();
    setupMocks();
    vi.mocked(useDeleteOutfitsId).mockReturnValue({
      mutate,
      isPending: false,
    } as any);

    render(<CreateOutfitModal {...defaultProps} outfit={editOutfit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Outfit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(mutate).toHaveBeenCalledWith(
      { id: 'outfit-1' },
      expect.objectContaining({
        onSuccess: expect.any(Function),
      }),
    );
  });

  it('does not show delete button in create mode', () => {
    setupMocks();
    render(<CreateOutfitModal {...defaultProps} />);
    expect(screen.queryByRole('button', { name: 'Delete Outfit' })).toBeNull();
  });

  it('names the close control, the outfit name field, and the select-items group with its count', () => {
    setupMocks();
    render(<CreateOutfitModal {...defaultProps} />);

    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Outfit Name (optional)' })).toBeInTheDocument();

    const group = screen.getByRole('group', { name: 'Select Items (0 selected)' });
    fireEvent.click(within(group).getByRole('button', { name: 'T-Shirt' }));
    expect(screen.getByRole('group', { name: 'Select Items (1 selected)' })).toBeInTheDocument();
  });

  it('paints the 2px indigo ring tokens on every focus stop in create mode', () => {
    setupMocks();
    render(<CreateOutfitModal {...defaultProps} />);

    expectEveryStopRings(screen.getByRole('dialog', { name: 'Create Outfit' }));
  });

  it('keeps the ring tokens on the delete confirmation controls', () => {
    setupMocks();
    render(<CreateOutfitModal {...defaultProps} outfit={editOutfit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Outfit' }));
    expectEveryStopRings(screen.getByRole('dialog', { name: 'Edit Outfit' }));
  });

  it('keeps the ring tokens on the disabled create control while a request is in flight', () => {
    setupMocks();
    vi.mocked(usePostOutfits).mockReturnValue({ mutate: vi.fn(), isPending: true } as any);
    render(<CreateOutfitModal {...defaultProps} />);
    fireEvent.click(screen.getByText('T-Shirt'));

    const create = screen.getByRole('button', { name: 'Creating...' });
    expect(create).toBeDisabled();
    expectRingTokens(create);
    expectEveryStopRings(screen.getByRole('dialog', { name: 'Create Outfit' }));
  });

  it('locks the body while open and releases it when closed or unmounted', () => {
    setupMocks();
    const { rerender, unmount } = render(<CreateOutfitModal {...defaultProps} isOpen={false} />);
    expect(document.body.style.overflow).toBe('');

    rerender(<CreateOutfitModal {...defaultProps} isOpen />);
    expect(document.body.style.overflow).toBe('hidden');

    rerender(<CreateOutfitModal {...defaultProps} isOpen={false} />);
    expect(document.body.style.overflow).toBe('');

    rerender(<CreateOutfitModal {...defaultProps} isOpen />);
    expect(document.body.style.overflow).toBe('hidden');

    unmount();
    expect(document.body.style.overflow).toBe('');
  });
});
