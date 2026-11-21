// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import OutfitModal from '../../pages/wardrobe/OutfitModal';

vi.mock('../../api/endpoints/outfits/outfits', () => ({
  usePatchOutfitsId: vi.fn(),
  useDeleteOutfitsId: vi.fn(),
}));

import { usePatchOutfitsId, useDeleteOutfitsId } from '../../api/endpoints/outfits/outfits';

const defaultProps = { isOpen: true, onClose: vi.fn(), onSuccess: vi.fn() };

let updateOutfit: ReturnType<typeof vi.fn>;
let deleteOutfit: ReturnType<typeof vi.fn>;

function makeOutfit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'outfit-1',
    userId: 'user-1',
    name: 'Weekend Casual',
    memberSignature: 'a'.repeat(64),
    wearableItems: [
      { id: 'item-1', name: 'T-Shirt', category: 'Top', images: [], archivedAt: null },
      { id: 'item-2', name: 'Jeans', category: 'Bottom', images: [], archivedAt: null },
    ],
    createdAt: '2024-01-01T00:00:00Z',
    generationCount: 3,
    ...overrides,
  } as never;
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  updateOutfit = vi.fn();
  deleteOutfit = vi.fn();
  vi.mocked(usePatchOutfitsId).mockReturnValue({ mutate: updateOutfit, isPending: false } as never);
  vi.mocked(useDeleteOutfitsId).mockReturnValue({ mutate: deleteOutfit, isPending: false } as never);
});

/**
 * Issue 313 — the dialog has no creation mode.
 *
 * An outfit is composed in the Fitting Room, so this surface only renames and
 * deletes an existing one. The tests below hold that boundary: there is no submit
 * that takes a member list, and the members are read-only.
 */
describe('no creation mode', () => {
  it('renders nothing without an outfit to edit', () => {
    const { container } = render(<OutfitModal {...defaultProps} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: /Create Outfit/ })).toBeNull();
  });

  it('offers only rename and delete as actions', () => {
    render(<OutfitModal {...defaultProps} outfit={makeOutfit()} />);

    expect(screen.getByRole('heading', { name: 'Edit Outfit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Outfit' })).toBeInTheDocument();
    // No member picker: the list is text, not a group of toggles.
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.queryByText(/selected/)).toBeNull();
  });
});

/**
 * Issue 332 — an outfit's members are frozen at creation.
 *
 * The dialog therefore renders them as a read-only list (marking the ones in
 * the Storage Box) and saves `{ name }` only. A build that still sent items gets a
 * `400` whose sentence must reach the user, because a silent no-op is the failure
 * this delivery exists to remove.
 */
describe('frozen members', () => {
  it('renders the members as a read-only list and says the set is fixed', () => {
    render(<OutfitModal {...defaultProps} outfit={makeOutfit()} />);

    const members = screen.getAllByTestId('outfit-member');
    expect(members).toHaveLength(2);
    expect(members[0]).toHaveTextContent('T-Shirt');
    expect(screen.getByText(/fixed when it is created/)).toBeInTheDocument();
  });

  it('marks an archived member with the Archived badge', () => {
    render(
      <OutfitModal
        {...defaultProps}
        outfit={makeOutfit({
          wearableItems: [
            { id: 'item-1', name: 'T-Shirt', category: 'Top', images: [], archivedAt: '2026-03-01T09:00:00.000Z' },
          ],
        })}
      />,
    );

    expect(screen.getByTestId('outfit-member-archived')).toHaveTextContent('Archived');
  });

  it('saves only the name', async () => {
    render(<OutfitModal {...defaultProps} outfit={makeOutfit()} />);

    fireEvent.change(screen.getByPlaceholderText('e.g. Weekend Casual'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(updateOutfit).toHaveBeenCalledWith(
      { id: 'outfit-1', data: { name: 'Renamed' } },
      expect.anything(),
    ));
    const payload = updateOutfit.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(Object.keys(payload.data)).toEqual(['name']);
  });

  it('shows the frozen-membership sentence when the save is refused with 400', async () => {
    updateOutfit.mockImplementation((_body: unknown, options: { onError?: (e: unknown) => void }) => {
      options.onError?.({
        response: {
          status: 400,
          data: {
            error: 'VALIDATION_ERROR',
            message: 'Request validation failed',
            details: [{ path: '', message: "Unrecognized key(s) in object: 'wearable_item_ids'" }],
          },
        },
      });
    });
    render(<OutfitModal {...defaultProps} outfit={makeOutfit()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/items cannot be changed/));
  });

  it('shows a not-found sentence when the outfit is gone', async () => {
    updateOutfit.mockImplementation((_body: unknown, options: { onError?: (e: unknown) => void }) => {
      options.onError?.({ response: { status: 404 } });
    });
    render(<OutfitModal {...defaultProps} outfit={makeOutfit()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/no longer exists/));
  });
});

/**
 * Issue 334 — deleting an outfit removes the outfit; its looks stay in history.
 * Issue 332 — a running try-on refuses the delete, so the control is disabled and
 * there is no way to force it.
 */
describe('delete confirmation', () => {
  it('states the record count and that the looks stay', () => {
    render(<OutfitModal {...defaultProps} outfit={makeOutfit({ generationCount: 3 })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Outfit' }));

    const sentence = screen.getByText(/Delete this outfit\?/).textContent ?? '';
    expect(sentence).toContain('3 try-on records');
    expect(sentence).toContain('stay in your history');
    expect(sentence).not.toContain('deletes its');
  });

  it('uses the singular for one record', () => {
    render(<OutfitModal {...defaultProps} outfit={makeOutfit({ generationCount: 1 })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Outfit' }));
    expect(screen.getByText(/Delete this outfit\?/).textContent).toContain('1 try-on record');
  });

  it('states no number for a true zero', () => {
    render(<OutfitModal {...defaultProps} outfit={makeOutfit({ generationCount: 0 })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Outfit' }));
    const sentence = screen.getByText(/Delete this outfit\?/).textContent ?? '';
    expect(sentence).not.toMatch(/\d/);
    expect(sentence).toContain('stay in your history');
  });

  it('disables confirmation while a try-on is running, with no forced delete', () => {
    render(
      <OutfitModal
        {...defaultProps}
        outfit={makeOutfit({
          latestGeneration: { id: 'gen-1', status: 'Pending', errorCode: null, createdAt: '2026-06-02T00:00:00.000Z' },
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete Outfit' }));

    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(screen.getByText(/still running for this outfit/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /anyway/i })).toBeNull();
  });

  it('confirms a delete and reports it to the page', async () => {
    deleteOutfit.mockImplementation((_body: unknown, options: { onSuccess?: () => void }) => {
      options.onSuccess?.();
    });
    const onNotice = vi.fn();
    render(<OutfitModal {...defaultProps} onNotice={onNotice} outfit={makeOutfit({ generationCount: 0 })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Outfit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(onNotice).toHaveBeenCalledWith({ deletedOutfit: true }));
    expect(deleteOutfit).toHaveBeenCalledWith({ id: 'outfit-1' }, expect.anything());
  });

  it('treats a 404 as already removed', async () => {
    deleteOutfit.mockImplementation((_body: unknown, options: { onError?: (e: unknown) => void }) => {
      options.onError?.({ response: { status: 404 } });
    });
    const onNotice = vi.fn();
    render(<OutfitModal {...defaultProps} onNotice={onNotice} outfit={makeOutfit({ generationCount: 0 })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Outfit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(onNotice).toHaveBeenCalledWith({ deletedOutfit: true }));
  });

  it('keeps the dialog open with a sentence when the delete is refused for another reason', async () => {
    deleteOutfit.mockImplementation((_body: unknown, options: { onError?: (e: unknown) => void }) => {
      options.onError?.({ response: { status: 500 } });
    });
    render(<OutfitModal {...defaultProps} outfit={makeOutfit({ generationCount: 0 })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Outfit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/status 500/));
  });

  it('sends nothing while the confirmation is still open', () => {
    render(<OutfitModal {...defaultProps} outfit={makeOutfit()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Outfit' }));

    expect(deleteOutfit).not.toHaveBeenCalled();
  });
});
