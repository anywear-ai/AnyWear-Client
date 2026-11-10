// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

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

function renderModal(item: GetWardrobe200Item) {
  return render(<ItemDetailsModal item={item} isOpen onClose={vi.fn()} onSuccess={vi.fn()} />);
}

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
    vi.spyOn(window, 'alert').mockImplementation(() => {});
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
    expect(window.alert).not.toHaveBeenCalled();
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
    const { rerender } = render(
      <ItemDetailsModal item={makeItem()} isOpen={false} onClose={vi.fn()} onSuccess={vi.fn()} />,
    );
    expect(document.body.style.overflow).toBe('');

    rerender(<ItemDetailsModal item={null} isOpen onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(document.body.style.overflow).toBe('');
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
