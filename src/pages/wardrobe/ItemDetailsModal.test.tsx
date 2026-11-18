// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react';

vi.mock('../../api/endpoints/wardrobe/wardrobe', () => ({
  usePatchWardrobeItemsId: vi.fn(),
  useDeleteWardrobeItemsId: vi.fn(),
  usePostWardrobeItemsItemIdRetag: vi.fn(),
}));

vi.mock('../../api/custom-instance', () => ({
  AXIOS_INSTANCE: { post: vi.fn() },
}));

vi.mock('../../components/CachedImage', () => ({
  default: ({ src, cacheKey, alt, className, ...rest }: any) => (
    <img src={src} alt={alt} className={className} data-cache-key={cacheKey} {...rest} />
  ),
}));

vi.mock('../../lib/imageUpload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/imageUpload')>();
  return { ...actual, uploadImageWithSignedPost: vi.fn() };
});

vi.mock('../../lib/imagePreparation', () => ({
  prepareImageForUpload: vi.fn(),
}));

import ItemDetailsModal from './ItemDetailsModal';
import { AXIOS_INSTANCE } from '../../api/custom-instance';
import { HEIC_UNSUPPORTED_MESSAGE, uploadImageWithSignedPost } from '../../lib/imageUpload';
import { prepareImageForUpload } from '../../lib/imagePreparation';
import {
  useDeleteWardrobeItemsId,
  usePatchWardrobeItemsId,
  usePostWardrobeItemsItemIdRetag,
} from '../../api/endpoints/wardrobe/wardrobe';
import type { GetWardrobe200Item } from '../../api/model/getWardrobe200Item';
import { useClientVersionRefusalStore } from '../../store/clientVersionRefusalStore';

const postMock = vi.mocked(AXIOS_INSTANCE.post);

const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

const FIELD_NAMES = [
  'Name',
  'Category',
  'Color',
  'Material',
  'Design',
  'Fit',
  'Pattern',
  'Neckline',
  'Sleeve Length',
  'Pockets',
  'Hemline',
  'Vibe',
  'Brand',
  'Weather Tags',
];

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

function makeItem(overrides: Partial<GetWardrobe200Item> = {}): GetWardrobe200Item {
  return {
    id: 'item-1',
    ownerId: 'user-1',
    name: 'Black Hoodie',
    // The gallery starts populated; the empty-gallery case is its own test.
    images: [{ imageId: 'image-1', url: 'https://signed.example.com/k.jpg', view: null, isPrimary: true }],
    category: 'Top',
    taggingStatus: 'complete',
    taggingStateVersion: 1,
    taggingErrorCode: null,
    taggingErrorMessage: null,
    weatherTags: null,
    styleAttributes: null,
    isPublic: null,
    imageEmbedding: null,
    createdAt: '2026-05-05T00:00:00.000Z',
    updatedAt: '2026-05-05T00:00:00.000Z',
    ...overrides,
  };
}

/** The props every render of this dialog needs; each test overrides only the callbacks it asserts. */
interface ModalOptions {
  onClose?: () => void;
  onSuccess?: () => void;
  onDeleted?: (outcome: 'deleted' | 'already-gone') => void;
  onRetagStarted?: () => void;
}

function modalElement(item: GetWardrobe200Item | null, isOpen: boolean, options: ModalOptions = {}) {
  return (
    <ItemDetailsModal
      item={item}
      isOpen={isOpen}
      onClose={options.onClose ?? vi.fn()}
      onSuccess={options.onSuccess ?? vi.fn()}
      onDeleted={options.onDeleted ?? vi.fn()}
      onRetagStarted={options.onRetagStarted ?? vi.fn()}
    />
  );
}

function renderModal(item: GetWardrobe200Item, options: ModalOptions = {}) {
  return render(modalElement(item, true, options));
}

/** The in-place delete question, scoped so its two answers are unambiguous. */
function deleteQuestion() {
  return screen.getByRole('group', { name: 'Delete this item?' });
}

/** The dialog's own Delete control, which the question replaces while it is open. */
function deleteControl() {
  return screen.getByRole('button', { name: 'Delete' });
}

/** A 409 body that names an outfit the Service says still holds the item. */
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

const S1 =
  'Nothing was deleted: this item is still in 1 outfit. Remove it from that outfit, or delete the outfit. An outfit cannot be saved with no items, so if this is its only item, delete it.';

describe('ItemDetailsModal', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    document.body.style.overflow = '';
    vi.mocked(usePatchWardrobeItemsId).mockReturnValue({ mutateAsync: vi.fn(), isPending: false } as any);
    vi.mocked(useDeleteWardrobeItemsId).mockReturnValue({ mutateAsync: vi.fn(), isPending: false } as any);
    vi.mocked(usePostWardrobeItemsItemIdRetag).mockReturnValue({ mutateAsync: vi.fn(), isPending: false } as any);
    vi.mocked(uploadImageWithSignedPost).mockResolvedValue(undefined);
    vi.mocked(prepareImageForUpload).mockImplementation(
      async (file: File) => new File([file], file.name, { type: 'image/jpeg' }),
    );
  });

  afterEach(() => {
    cleanup();
    document.body.style.overflow = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** The Android WebView: `isTauri` plus the platform token in the user agent. */
  function stubAndroidApp() {
    vi.stubGlobal('isTauri', true);
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36',
    });
  }

  /** The desktop client: a Tauri shell whose WebView user agent has no Android token. */
  function stubDesktopApp() {
    vi.stubGlobal('isTauri', true);
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    });
  }

  it('offers one Add image tile and one narrow file input, with no camera entry', () => {
    const { container } = renderModal(makeItem());
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'));

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
    expect(inputs[0]).not.toHaveAttribute('capture');
    expect(screen.getByRole('button', { name: 'Add image' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take photo' })).toBeNull();
  });

  it('narrows the add-image picker and shows the HEIC guidance inline before any network call', async () => {
    const { container } = renderModal(makeItem());
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');

    expect(input).not.toBeNull();
    expect(input).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');

    fireEvent.change(input!, { target: { files: [new File(['x'], 'photo.heic')] } });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(HEIC_UNSUPPORTED_MESSAGE);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('renders the Add image tile and prepares the file before reserving as JPEG', async () => {
    postMock
      .mockResolvedValueOnce({
        data: {
          reservationId: 'reservation-1',
          expiresAt: '2026-10-30T19:00:00.000Z',
          upload: { url: 'https://upload.example.com', fields: { key: 's3-post-field' } },
        },
      })
      .mockResolvedValueOnce({
        data: { itemId: 'item-1', imageId: 'image-new', downloadUrl: 'https://signed.example.com/new.jpg' },
      });

    const { container } = renderModal(makeItem());
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'));
    expect(inputs).toHaveLength(1);

    expect(screen.getByRole('button', { name: 'Add image' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take photo' })).toBeNull();
    const libraryInput = inputs[0];
    expect(libraryInput).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
    expect(libraryInput).not.toHaveAttribute('capture');

    fireEvent.change(libraryInput, {
      target: { files: [new File(['bytes'], 'photo.png', { type: 'image/png' })] },
    });

    await waitFor(() => expect(prepareImageForUpload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    expect(postMock).toHaveBeenNthCalledWith(1, '/wardrobe/items/item-1/upload-url', {
      contentType: 'image/jpeg',
    });
  });

  it('paints the confirmation download URL and submits image ids instead of keys', async () => {
    const updateItem = vi.fn().mockResolvedValue({});
    vi.mocked(usePatchWardrobeItemsId).mockReturnValue({ mutateAsync: updateItem, isPending: false } as any);
    postMock
      .mockResolvedValueOnce({
        data: {
          reservationId: 'reservation-1',
          expiresAt: '2026-10-30T19:00:00.000Z',
          upload: { url: 'https://upload.example.com', fields: { key: 's3-post-field' } },
        },
      })
      .mockResolvedValueOnce({
        data: { itemId: 'item-1', imageId: 'image-new', downloadUrl: 'https://signed.example.com/new.jpg' },
      });

    const { container } = renderModal(makeItem());
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(input!, {
      target: { files: [new File(['bytes'], 'photo.jpg', { type: 'image/jpeg' })] },
    });

    // The gallery and the thumbnail row paint the confirmation's signed
    // download URL, cached under the new image record's id.
    const thumbnail = await screen.findByAltText('Image 2');
    expect(thumbnail).toHaveAttribute('src', 'https://signed.example.com/new.jpg');
    expect(thumbnail).toHaveAttribute('data-cache-key', 'image-new');
    expect(postMock).toHaveBeenNthCalledWith(2, '/wardrobe/items/item-1/upload', {
      reservationId: 'reservation-1',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(updateItem).toHaveBeenCalledTimes(1));
    const body = updateItem.mock.calls[0][0].data;
    expect(body.images).toEqual([
      { imageId: 'image-1', isPrimary: true },
      { imageId: 'image-new', isPrimary: false },
    ]);
    // The whole serialized body is the renamed contract: no legacy image list
    // and no URL.
    expect(Object.keys(JSON.parse(JSON.stringify(body))).sort()).toEqual(['category', 'images', 'name']);
    expect(JSON.stringify(body)).not.toContain('signed.example.com');
  });

  it('renders the server message for a terminal unsupported-format failure and offers no Re-tag', () => {
    renderModal(makeItem({
      taggingStatus: 'failed',
      taggingErrorCode: 'input_image_unsupported_format',
      taggingErrorMessage: 'Image format image/heic cannot be sent to the provider',
    }));

    expect(screen.getByRole('alert'))
      .toHaveTextContent('Image format image/heic cannot be sent to the provider');
    expect(screen.getByText('Tagging Failed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /re-tag/i })).toBeNull();
  });

  it('keeps the Re-tag action when the failure is not the terminal format code', () => {
    renderModal(makeItem({
      taggingStatus: 'failed',
      taggingErrorCode: null,
      taggingErrorMessage: 'Auto-tagging failed unexpectedly',
    }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Auto-tagging failed unexpectedly')).toBeNull();
    expect(screen.getByRole('button', { name: /re-tag/i })).toBeInTheDocument();
  });

  it('announces all 14 field labels without the required asterisk, plus the View and Primary controls', () => {
    renderModal(makeItem());

    for (const name of FIELD_NAMES) {
      expect(screen.getByRole('textbox', { name }), `${name} is not a named textbox`).toBeInTheDocument();
    }
    expect(screen.getByRole('combobox', { name: 'View' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Primary' })).toBeInTheDocument();
  });

  it('gives every icon-only gallery control an authored name', () => {
    renderModal(makeItem());

    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show image 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove image 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add image' })).toBeInTheDocument();
  });

  it('paints the 2px indigo ring tokens on every focus stop in the dialog', () => {
    renderModal(makeItem());

    expectEveryStopRings(screen.getByRole('dialog', { name: 'Item Details' }));
  });

  it('keeps the ring tokens on the disabled save control while a save is in flight', () => {
    vi.mocked(usePatchWardrobeItemsId).mockReturnValue({ mutateAsync: vi.fn(), isPending: true } as any);
    renderModal(makeItem());

    const save = screen.getByRole('button', { name: 'Saving...' });
    expect(save).toBeDisabled();
    expectRingTokens(save);
    expectEveryStopRings(screen.getByRole('dialog', { name: 'Item Details' }));
  });

  it('still rings every remaining stop when the item has no images', () => {
    renderModal(makeItem({ images: [] }));

    expect(screen.queryByRole('button', { name: /Show image/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'View' })).toBeNull();
    // The one add entry stays on screen even with an empty gallery.
    expect(screen.getByRole('button', { name: 'Add image' })).toBeInTheDocument();
    expectEveryStopRings(screen.getByRole('dialog', { name: 'Item Details' }));
  });

  it('shows a decode failure inline and says nothing when a chooser is cancelled', async () => {
    vi.mocked(prepareImageForUpload).mockRejectedValueOnce(new Error('Could not process this image'));
    const { container } = renderModal(makeItem());
    const libraryInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;

    fireEvent.change(libraryInput, { target: { files: [] } });
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.change(libraryInput, {
      target: { files: [new File(['bytes'], 'photo.jpg', { type: 'image/jpeg' })] },
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not process this image');
    expect(postMock).not.toHaveBeenCalled();
    // The Add image tile remains the one-click retry.
    expect(screen.getByRole('button', { name: 'Add image' })).toBeInTheDocument();
  });

  it('locks the body while open and restores it on unmount', () => {
    const { unmount } = renderModal(makeItem());
    expect(document.body.style.overflow).toBe('hidden');

    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('locks nothing while closed or without an item', () => {
    const { rerender } = render(modalElement(makeItem(), false));
    expect(document.body.style.overflow).toBe('');

    rerender(modalElement(null, true));
    expect(document.body.style.overflow).toBe('');
  });

  describe('the in-place delete confirmation', () => {
    function stubDelete(settles: (id: string) => Promise<unknown>) {
      const deleteItem = vi.fn((variables: { id: string }) => settles(variables.id));
      vi.mocked(useDeleteWardrobeItemsId).mockReturnValue({ mutateAsync: deleteItem, isPending: false } as any);
      return deleteItem;
    }

    async function openQuestionAndConfirm() {
      fireEvent.click(deleteControl());
      fireEvent.click(within(deleteQuestion()).getByRole('button', { name: 'Delete' }));
    }

    it('renders the question in place of the Delete control without sending anything', () => {
      const deleteItem = stubDelete(async () => ({}));
      renderModal(makeItem());

      expect(screen.queryByText('Delete this item? This cannot be undone.')).toBeNull();

      fireEvent.click(deleteControl());

      const question = deleteQuestion();
      expect(within(question).getByText('Delete this item? This cannot be undone.')).toBeInTheDocument();
      // The dialog's other actions keep their places while the question is up;
      // the question brings its own Cancel beside its Delete.
      const dialog = screen.getByRole('dialog', { name: 'Item Details' });
      for (const name of ['Save Changes', 'Re-tag']) {
        expect(within(dialog).getByRole('button', { name })).toBeInTheDocument();
      }
      expect(within(dialog).getAllByRole('button', { name: 'Cancel' })).toHaveLength(2);
      expect(deleteItem).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog', { name: 'Item Details' })).toBeInTheDocument();
    });

    it('sends nothing on Cancel and returns focus to the Delete control', () => {
      const deleteItem = stubDelete(async () => ({}));
      renderModal(makeItem());

      fireEvent.click(deleteControl());
      fireEvent.click(within(deleteQuestion()).getByRole('button', { name: 'Cancel' }));

      expect(deleteItem).not.toHaveBeenCalled();
      expect(screen.queryByRole('group', { name: 'Delete this item?' })).toBeNull();
      // Declining restores the control the question replaced.
      expect(document.activeElement).toBe(deleteControl());
    });

    it('sends exactly one DELETE with the item id and reports the deletion', async () => {
      const deleteItem = stubDelete(async () => ({}));
      const onDeleted = vi.fn();
      renderModal(makeItem(), { onDeleted });

      openQuestionAndConfirm();

      await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('deleted'));
      expect(deleteItem).toHaveBeenCalledTimes(1);
      expect(deleteItem).toHaveBeenCalledWith({ id: 'item-1' });
    });

    it('shows Deleting... with an inert Cancel, backdrop and Escape while the request is out', async () => {
      let settle!: () => void;
      const pending = new Promise<void>((resolve) => { settle = resolve; });
      let pendingFlag = false;
      const deleteItem = vi.fn(async () => {
        pendingFlag = true;
        await pending;
      });
      const onClose = vi.fn();
      const onDeleted = vi.fn();
      vi.mocked(useDeleteWardrobeItemsId).mockImplementation(
        () => ({ mutateAsync: deleteItem, isPending: pendingFlag }) as any,
      );
      const options = { onClose, onDeleted };
      const { container, rerender } = render(modalElement(makeItem(), true, options));

      fireEvent.click(deleteControl());
      fireEvent.click(within(deleteQuestion()).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(deleteItem).toHaveBeenCalledTimes(1));

      // The mutation reports its pending state on the next render, as the real hook does.
      rerender(modalElement(makeItem(), true, options));

      const affirmative = screen.getByRole('button', { name: 'Deleting...' });
      expect(affirmative).toBeDisabled();
      expect(within(deleteQuestion()).getByRole('button', { name: 'Cancel' })).toBeDisabled();

      // Every exit is inert for that window: no second DELETE and no close.
      fireEvent.keyDown(document, { key: 'Escape' });
      const backdrop = Array.from(container.querySelectorAll<HTMLElement>('div'))
        .find((element) => element.classList.contains('bg-gray-500/75'))!;
      fireEvent.click(backdrop);
      fireEvent.click(within(deleteQuestion()).getByRole('button', { name: 'Cancel' }));

      expect(onClose).not.toHaveBeenCalled();
      expect(deleteItem).toHaveBeenCalledTimes(1);
      expect(deleteQuestion()).toBeInTheDocument();

      pendingFlag = false;
      await act(async () => {
        settle();
        await pending;
      });
      await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('deleted'));
      expect(deleteItem).toHaveBeenCalledTimes(1);
    });

    it('renders S1 inside the question and keeps the dialog open when an outfit still holds the item', async () => {
      stubDelete(async () => {
        throw { response: { status: 409, data: referencedBody([{ resource: 'outfit', count: 1 }]) } };
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      renderModal(makeItem());

      openQuestionAndConfirm();

      const alert = await waitFor(() => within(deleteQuestion()).getByRole('alert'));
      expect(alert).toHaveTextContent(S1);
      expect(screen.getByRole('dialog', { name: 'Item Details' })).toBeInTheDocument();
      expect(deleteQuestion()).toBeInTheDocument();
    });

    const failureCases: Array<[string, unknown, string]> = [
      [
        'S2 for a 409 naming three outfits',
        { response: { status: 409, data: referencedBody([{ resource: 'outfit', count: 3 }]) } },
        'Nothing was deleted: this item is still in 3 outfits. Remove it from those outfits, or delete them. An outfit cannot be saved with no items, so an outfit holding only this item has to be deleted.',
      ],
      [
        'S3 for a 409 naming an outfit with no count',
        { response: { status: 409, data: referencedBody([{ resource: 'outfit' }]) } },
        'Nothing was deleted: this item is still in one or more outfits. Remove it from those outfits, or delete them. An outfit cannot be saved with no items, so an outfit holding only this item has to be deleted.',
      ],
      [
        'S4 for a 409 naming another resource',
        { response: { status: 409, data: referencedBody([{ resource: 'outfit_generation', count: 2 }], 'Delete the try-on first.') } },
        'Delete the try-on first.',
      ],
      [
        'S6 for a 503',
        { response: { status: 503, data: {} } },
        'Could not delete this item (server error 503). Try again.',
      ],
      [
        'S7 for a request that never reached the Service',
        { isAxiosError: true, request: {}, message: 'Network Error' },
        'Could not reach the server. Check your connection and try again.',
      ],
    ];

    it.each(failureCases)('renders %s in the question', async (_label, rejection, expected) => {
      stubDelete(async () => { throw rejection; });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      renderModal(makeItem());

      openQuestionAndConfirm();

      const alert = await waitFor(() => within(deleteQuestion()).getByRole('alert'));
      expect(alert).toHaveTextContent(expected);
      expect(screen.getByRole('dialog', { name: 'Item Details' })).toBeInTheDocument();
    });

    it('reports a 404 as already gone to its caller instead of painting a failure', async () => {
      stubDelete(async () => {
        throw { response: { status: 404, data: { error: 'NOT_FOUND', message: 'Wardrobe item not found' } } };
      });
      const onDeleted = vi.fn();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      renderModal(makeItem(), { onDeleted });

      openQuestionAndConfirm();

      await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('already-gone'));
      expect(within(deleteQuestion()).queryByRole('alert')).toBeNull();
    });

    it('keeps both answers inside the dialog single Tab trap and wraps from the last stop', () => {
      stubDelete(async () => ({}));
      renderModal(makeItem());

      fireEvent.click(deleteControl());

      const question = deleteQuestion();
      const cancel = within(question).getByRole('button', { name: 'Cancel' });
      const affirmative = within(question).getByRole('button', { name: 'Delete' });

      // The question focuses its Cancel first, and both answers are focus stops.
      expect(document.activeElement).toBe(cancel);
      affirmative.focus();
      expect(document.activeElement).toBe(affirmative);

      // The dialog's Cancel is the trap's last stop; forward Tab returns to the
      // panel's Close control, so both answers sit inside one trap.
      const dialog = screen.getByRole('dialog', { name: 'Item Details' });
      const dialogCancels = within(dialog).getAllByRole('button', { name: 'Cancel' });
      const dialogCancel = dialogCancels[dialogCancels.length - 1];
      dialogCancel.focus();
      expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(false);
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' }));
    });

    it('leaves Escape closing the whole dialog, because the question adds no handler', () => {
      stubDelete(async () => ({}));
      const onClose = vi.fn();
      renderModal(makeItem(), { onClose });

      fireEvent.click(deleteControl());
      fireEvent.keyDown(document, { key: 'Escape' });

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('the failure sentences around a latched refusal', () => {
    beforeEach(() => {
      useClientVersionRefusalStore.setState({ refusal: null });
    });

    afterEach(() => {
      useClientVersionRefusalStore.setState({ refusal: null });
    });

    function latchRefusal() {
      useClientVersionRefusalStore.setState({
        refusal: { minimumClientVersion: 9, receivedClientVersion: 8, detailsReported: true },
      });
    }

    /** Every failure path in this dialog, driven through its own rejecting mutation. */
    function stubFailures() {
      const updateItem = vi.fn().mockRejectedValue(new Error('failed'));
      const deleteItem = vi.fn().mockRejectedValue(new Error('failed'));
      const retagItem = vi.fn().mockRejectedValue(new Error('failed'));
      vi.mocked(usePatchWardrobeItemsId).mockReturnValue({ mutateAsync: updateItem, isPending: false } as any);
      vi.mocked(useDeleteWardrobeItemsId).mockReturnValue({ mutateAsync: deleteItem, isPending: false } as any);
      vi.mocked(usePostWardrobeItemsItemIdRetag).mockReturnValue({ mutateAsync: retagItem, isPending: false } as any);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      return { updateItem, deleteItem, retagItem };
    }

    /** Every sentence currently painted in a `role="alert"`, in document order. */
    function alertText(): string {
      return screen.queryAllByRole('alert').map((element) => element.textContent ?? '').join(' ');
    }

    async function driveEveryFailure() {
      const mocked = stubFailures();
      renderModal(makeItem());

      fireEvent.click(screen.getByRole('button', { name: 'Re-tag' }));
      await waitFor(() => expect(mocked.retagItem).toHaveBeenCalledTimes(1));
      fireEvent.click(deleteControl());
      fireEvent.click(within(deleteQuestion()).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(mocked.deleteItem).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
      await waitFor(() => expect(mocked.updateItem).toHaveBeenCalledTimes(1));
    }

    it('renders the three failure sentences while nothing is refused', async () => {
      const mocked = stubFailures();
      renderModal(makeItem());

      fireEvent.click(screen.getByRole('button', { name: 'Re-tag' }));
      await waitFor(() => expect(mocked.retagItem).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(alertText()).toContain('Failed to start re-tagging'));

      fireEvent.click(deleteControl());
      fireEvent.click(within(deleteQuestion()).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(mocked.deleteItem).toHaveBeenCalledTimes(1));
      // A rejection with no status is a request that never reached the Service.
      await waitFor(() => expect(alertText()).toContain('Could not reach the server. Check your connection and try again.'));

      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
      await waitFor(() => expect(mocked.updateItem).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(alertText()).toContain('Failed to update item'));
      // The delete sentence from the step before is still inside the question.
      expect(deleteQuestion()).toHaveTextContent('Could not reach the server. Check your connection and try again.');
    });

    it('writes no sentence once the Client version refusal is latched', async () => {
      latchRefusal();

      await driveEveryFailure();

      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByText('Failed to start re-tagging')).toBeNull();
      expect(screen.queryByText('Failed to update item')).toBeNull();
    });
  });

  describe('the update and re-tag sentences', () => {
    it('prints the update failure above the action row and keeps the person edits', async () => {
      const updateItem = vi.fn().mockRejectedValue(new Error('failed'));
      vi.mocked(usePatchWardrobeItemsId).mockReturnValue({ mutateAsync: updateItem, isPending: false } as any);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      renderModal(makeItem());

      fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Renamed Hoodie' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Failed to update item');
      // Above the action row, not inside it.
      expect(alert.nextElementSibling).toContainElement(screen.getByRole('button', { name: 'Save Changes' }));
      expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Renamed Hoodie');
      expect(screen.getByRole('dialog', { name: 'Item Details' })).toBeInTheDocument();
    });

    it('prints the re-tag failure above the action row', async () => {
      const retagItem = vi.fn().mockRejectedValue(new Error('failed'));
      vi.mocked(usePostWardrobeItemsItemIdRetag).mockReturnValue({ mutateAsync: retagItem, isPending: false } as any);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      renderModal(makeItem());

      fireEvent.click(screen.getByRole('button', { name: 'Re-tag' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Failed to start re-tagging');
      expect(screen.getByRole('dialog', { name: 'Item Details' })).toBeInTheDocument();
    });

    it('reports a started re-tag to its caller so the message outlives the dialog', async () => {
      const retagItem = vi.fn().mockResolvedValue({});
      const onRetagStarted = vi.fn();
      const onSuccess = vi.fn();
      vi.mocked(usePostWardrobeItemsItemIdRetag).mockReturnValue({ mutateAsync: retagItem, isPending: false } as any);
      renderModal(makeItem(), { onRetagStarted, onSuccess });

      fireEvent.click(screen.getByRole('button', { name: 'Re-tag' }));

      await waitFor(() => expect(onRetagStarted).toHaveBeenCalledTimes(1));
      // N1 belongs to the page notice now, not to this dialog's own close path.
      expect(onSuccess).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
  describe('in the desktop client', () => {
    beforeEach(() => {
      stubDesktopApp();
    });

    it('renders the single Add image tile and one file input', () => {
      const { container } = renderModal(makeItem());
      const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'));

      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
      expect(inputs[0]).not.toHaveAttribute('capture');
      expect(screen.getByRole('button', { name: 'Add image' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Take photo' })).toBeNull();
    });
  });

  describe('in the Android app', () => {
    beforeEach(() => {
      stubAndroidApp();
    });

    it('keeps both capture entries with the attributes each system path needs', () => {
      const { container } = renderModal(makeItem());
      const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'));

      expect(inputs).toHaveLength(2);
      expect(screen.getByRole('button', { name: 'Choose from library' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Take photo' })).toBeInTheDocument();
      // The camera input is the `image/*` + capture one, single file.
      const cameraInput = inputs.find((input) => input.getAttribute('accept') === 'image/*')!;
      expect(cameraInput).toHaveAttribute('capture', 'environment');
      expect(cameraInput).not.toHaveAttribute('multiple');
      // The library input keeps the narrow list: it only ever opens the picker.
      const libraryInput = inputs.find(
        (input) => input.getAttribute('accept') === 'image/jpeg,image/png,image/webp',
      )!;
      expect(libraryInput).not.toHaveAttribute('capture');
    });
  });
});
