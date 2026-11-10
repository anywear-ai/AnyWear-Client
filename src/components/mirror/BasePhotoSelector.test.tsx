// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../api/endpoints/vto/vto', () => ({
  useGetVtoBasePhotos: vi.fn(),
  usePostVtoBasePhotosUploadUrl: vi.fn(),
  usePostVtoBasePhotosUpload: vi.fn(),
  usePatchVtoBasePhotosId: vi.fn(),
  useDeleteVtoBasePhotosId: vi.fn(),
}));

vi.mock('../../lib/imageUpload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/imageUpload')>();
  return { ...actual, uploadImageWithSignedPost: vi.fn() };
});

vi.mock('../../lib/imagePreparation', () => ({
  prepareImageForUpload: vi.fn(),
}));

vi.mock('../../components/CachedImage', () => ({
  default: ({ src, cacheKey, alt, className, ...rest }: any) => (
    <img src={src} alt={alt} className={className} data-cache-key={cacheKey} {...rest} />
  ),
}));

import BasePhotoSelector from './BasePhotoSelector';
import { HEIC_UNSUPPORTED_MESSAGE, uploadImageWithSignedPost } from '../../lib/imageUpload';
import { prepareImageForUpload } from '../../lib/imagePreparation';
import {
  useDeleteVtoBasePhotosId,
  useGetVtoBasePhotos,
  usePatchVtoBasePhotosId,
  usePostVtoBasePhotosUpload,
  usePostVtoBasePhotosUploadUrl,
} from '../../api/endpoints/vto/vto';

describe('BasePhotoSelector', () => {
  const reservePhotoUpload = vi.fn();
  const confirmPhotoUpload = vi.fn();
  const setDefault = vi.fn();
  const deletePhoto = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    vi.mocked(useGetVtoBasePhotos).mockReturnValue({ data: [], isLoading: false } as any);
    vi.mocked(usePostVtoBasePhotosUploadUrl).mockReturnValue({ mutateAsync: reservePhotoUpload } as any);
    vi.mocked(usePostVtoBasePhotosUpload).mockReturnValue({ mutateAsync: confirmPhotoUpload } as any);
    vi.mocked(usePatchVtoBasePhotosId).mockReturnValue({ mutate: setDefault } as any);
    vi.mocked(useDeleteVtoBasePhotosId).mockReturnValue({ mutate: deletePhoto } as any);
    vi.mocked(uploadImageWithSignedPost).mockResolvedValue(undefined);
    vi.mocked(prepareImageForUpload).mockImplementation(
      async (file: File) => new File([file], file.name, { type: 'image/jpeg' }),
    );
  });

  afterEach(() => {
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

  function renderSelector(
    photos: unknown[],
    props: {
      selectedPhotoId?: string | null;
      onSelect?: (id: string | null) => void;
      onUploaded?: (id: string) => void;
    } = {},
  ) {
    vi.mocked(useGetVtoBasePhotos).mockReturnValue({ data: photos, isLoading: false } as any);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rendered = render(
      <QueryClientProvider client={queryClient}>
        <BasePhotoSelector
          selectedPhotoId={props.selectedPhotoId ?? null}
          onSelect={props.onSelect ?? (() => {})}
          onUploaded={props.onUploaded ?? (() => {})}
        />
      </QueryClientProvider>,
    );
    return { ...rendered, queryClient };
  }

  const ownPhoto = {
    id: 'photo-own',
    userId: 'user-1',
    imageId: 'image-own',
    url: 'https://signed.example.com/own.jpg',
    isDefault: true,
    source: 'user',
    createdAt: '2026-06-01T00:00:00.000Z',
  };
  const systemPhoto = {
    id: 'photo-system',
    userId: null,
    imageId: 'image-system',
    url: 'https://signed.example.com/system.jpg',
    isDefault: false,
    source: 'system',
    createdAt: '2026-05-01T00:00:00.000Z',
  };

  it('offers one Upload entry and one narrow file input, with no camera entry', () => {
    const { container } = renderSelector([]);
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'));

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
    expect(inputs[0]).not.toHaveAttribute('capture');
    expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take photo' })).toBeNull();
  });

  it('narrows the picker and reports the HEIC guidance in an alert before reserving', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <BasePhotoSelector selectedPhotoId={null} onSelect={() => {}} onUploaded={() => {}} />
      </QueryClientProvider>,
    );

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');

    // The browser omits the MIME type, so only the filename identifies the format.
    fireEvent.change(input!, { target: { files: [new File(['x'], 'photo.heic')] } });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(HEIC_UNSUPPORTED_MESSAGE);
    expect(reservePhotoUpload).not.toHaveBeenCalled();
    // The one entry is still there after the failure.
    expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument();
  });

  it('shows a decode failure inline and leaves the single Upload entry as the retry', async () => {
    vi.mocked(prepareImageForUpload).mockRejectedValueOnce(new Error('Could not process this image'));
    const { container } = renderSelector([]);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;

    // A cancelled picker supplies no file: no hint, no request.
    fireEvent.change(input, { target: { files: [] } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(reservePhotoUpload).not.toHaveBeenCalled();

    fireEvent.change(input, {
      target: { files: [new File(['bytes'], 'photo.jpg', { type: 'image/jpeg' })] },
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not process this image');
    expect(reservePhotoUpload).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument();
  });

  it('renders the effective default across own and system photos', () => {
    renderSelector([ownPhoto, systemPhoto]);

    expect(screen.getAllByText(/Default photo/).length).toBeGreaterThan(0);
    expect(screen.getByText(/System photo/)).toBeInTheDocument();
    // The shared system photo cannot be deleted; an own photo can.
    expect(screen.queryByRole('button', { name: 'Delete this base photo' })).toBeInTheDocument();
    const articles = screen.getAllByRole('article');
    const systemArticle = articles.find((article) => article.textContent?.includes('System photo'));
    expect(systemArticle?.querySelector('button[aria-label="Delete this base photo"]')).toBeNull();
  });

  it('renders the system photo as the effective default when the caller points at it', () => {
    renderSelector([{ ...ownPhoto, isDefault: false }, { ...systemPhoto, isDefault: true }]);

    const articles = screen.getAllByRole('article');
    const systemArticle = articles.find((article) => article.textContent?.includes('Default photo'));
    expect(systemArticle).toBeDefined();
    expect(screen.getAllByText(/Default photo/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^System photo/)).toBeNull();
    expect(systemArticle?.querySelector('button[aria-label="Delete this base photo"]')).toBeNull();
  });

  it('moves the default pointer to a system photo through PATCH', () => {
    renderSelector([{ ...ownPhoto, isDefault: false }, systemPhoto]);

    const articles = screen.getAllByRole('article');
    const systemArticle = articles.find((article) => article.textContent?.includes('System photo'));
    const setDefaultButton = systemArticle?.querySelector<HTMLButtonElement>('button[aria-label="Set this photo as default"]');
    expect(setDefaultButton).not.toBeNull();

    fireEvent.click(setDefaultButton!);

    expect(setDefault).toHaveBeenCalledWith(
      { id: 'photo-system', data: { is_default: true } },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it('reports a confirmed upload through onUploaded instead of selecting it', async () => {
    reservePhotoUpload.mockResolvedValue({
      reservationId: 'reservation-1',
      upload: { url: 'https://upload.example.com', fields: { key: 'base-photos/new.jpg' } },
    });
    confirmPhotoUpload.mockResolvedValue({ ...ownPhoto, id: 'photo-new', isDefault: false });
    const onSelect = vi.fn();
    const onUploaded = vi.fn();
    const { container } = renderSelector([ownPhoto], { onSelect, onUploaded });

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    fireEvent.change(input!, {
      target: { files: [new File(['bytes'], 'photo.jpg', { type: 'image/jpeg' })] },
    });

    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith('photo-new'));
    // The page owns adoption; the selector must not select the photo itself.
    expect(onSelect).not.toHaveBeenCalled();
    // The reservation names the prepared JPEG, not the picked PNG.
    expect(reservePhotoUpload).toHaveBeenCalledWith({ data: { contentType: 'image/jpeg' } });
    expect(uploadImageWithSignedPost).toHaveBeenCalledWith(
      { url: 'https://upload.example.com', fields: { key: 'base-photos/new.jpg' } },
      expect.any(File),
    );
  });

  describe('delete confirmation', () => {
    const otherOwnPhoto = {
      ...ownPhoto,
      id: 'photo-other',
      imageId: 'image-other',
      url: 'https://signed.example.com/other.jpg',
      isDefault: false,
    };

    /** An Axios rejection: the status and body live on `error.response`. */
    function rejection(status: number, data?: unknown) {
      return { isAxiosError: true, response: { status, data } };
    }

    /** The Service's 409 body for a photo a try-on still references. */
    function referencedBody(dependentResources: { resource: string; count?: number }[], hint?: string) {
      return {
        error: 'RESOURCE_REFERENCED',
        message: 'The base photo is still referenced by other resources',
        details: {
          reason: 'RESOURCE_REFERENCED',
          dependent_resources: dependentResources,
          action: 'DELETE_DEPENDENTS_FIRST',
          hint: hint ?? 'Delete the outfit generation that references this base photo, then delete the photo',
        },
      };
    }

    /** Answer the card's question the way the user does. */
    function confirmDelete(index = 0) {
      fireEvent.click(screen.getAllByRole('button', { name: 'Delete this base photo' })[index]);
      fireEvent.click(screen.getByRole('button', { name: 'Yes, Delete' }));
    }

    /** Settle the pending DELETE the way TanStack Query does. */
    function resolveDelete() {
      const options = deletePhoto.mock.calls[deletePhoto.mock.calls.length - 1][1];
      act(() => options.onSuccess());
      act(() => options.onSettled?.());
    }

    function rejectDelete(error: unknown) {
      const options = deletePhoto.mock.calls[deletePhoto.mock.calls.length - 1][1];
      act(() => options.onError(error));
      act(() => options.onSettled?.());
    }

    function expectCardSentence(sentence: string) {
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toBe(sentence);
      return alert;
    }

    it('asks in the card instead of in a browser dialog and sends nothing before Yes, Delete', () => {
      const confirm = vi.spyOn(window, 'confirm');
      renderSelector([ownPhoto, systemPhoto]);

      fireEvent.click(screen.getByRole('button', { name: 'Delete this base photo' }));

      const question = screen.getByText('Delete this base photo?');
      const card = question.closest('article');
      expect(card).not.toBeNull();
      expect(within(card!).getByRole('button', { name: 'Yes, Delete' })).toBeInTheDocument();
      expect(within(card!).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      // The confirmation is the page's own control: no native dialog, no request.
      expect(confirm).not.toHaveBeenCalled();
      expect(deletePhoto).not.toHaveBeenCalled();
      // Cancel owns focus while the question is open.
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    });

    it('closes on Cancel, sends nothing, and returns focus to that card Delete', () => {
      renderSelector([ownPhoto]);

      fireEvent.click(screen.getByRole('button', { name: 'Delete this base photo' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByText('Delete this base photo?')).toBeNull();
      expect(deletePhoto).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete this base photo' }));
    });

    it('closes on Escape without a request and returns focus to that card Delete', () => {
      renderSelector([ownPhoto]);

      fireEvent.click(screen.getByRole('button', { name: 'Delete this base photo' }));
      fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' });

      expect(screen.queryByText('Delete this base photo?')).toBeNull();
      expect(deletePhoto).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete this base photo' }));
    });

    it('issues one DELETE per confirmation and disables every delete control while it is in flight', () => {
      renderSelector([ownPhoto, otherOwnPhoto]);

      confirmDelete(1);

      expect(deletePhoto).toHaveBeenCalledTimes(1);
      expect(deletePhoto.mock.calls[0][0]).toEqual({ id: 'photo-other' });
      // The card that sent it reads Removing and both answers are disabled, so a
      // second activation cannot start a second request.
      const removing = screen.getByRole('button', { name: 'Removing…' });
      expect(removing).toBeDisabled();
      fireEvent.click(removing);
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(deletePhoto).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Delete this base photo?')).toBeInTheDocument();

      // The deleting card loses its select control; because its question is the
      // overlay now, its Set Default control is not rendered at all. The other
      // card's Delete is disabled and its select control stays available.
      expect(screen.getByRole('button', { name: 'Select base photo 2' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Set this photo as default' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Select base photo 1, default' })).toBeEnabled();
      expect(screen.getAllByRole('button', { name: 'Delete this base photo' })).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'Delete this base photo' })).toBeDisabled();
    });

    it('restores the card actions after a failed delete', () => {
      renderSelector([ownPhoto, otherOwnPhoto]);

      confirmDelete(1);
      rejectDelete(rejection(409, referencedBody([{ resource: 'outfit_generation', count: 1 }])));

      // The question is gone, so the card offers its actions again and is
      // selectable: the failure does not leave a card that cannot be used.
      expect(screen.getByRole('button', { name: 'Set this photo as default' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Select base photo 2' })).toBeEnabled();
      const deletes = screen.getAllByRole('button', { name: 'Delete this base photo' });
      expect(deletes).toHaveLength(2);
      for (const control of deletes) expect(control).toBeEnabled();
    });

    it('keeps the action overlay visible while the question is open', () => {
      renderSelector([ownPhoto]);
      const actions = () => screen.getByTestId('base-photo-actions');
      expect(actions().className).toContain('sm:opacity-0');

      fireEvent.click(screen.getByRole('button', { name: 'Delete this base photo' }));

      // The reveal has no hover or focus gate while the question is open, so a
      // pointer that leaves the card cannot hide it.
      expect(actions().className).toContain('opacity-100');
      expect(actions().className).not.toContain('opacity-0');
    });

    it('trims the deleted row from the cached list and clears the selection with null', () => {
      const onSelect = vi.fn();
      const { queryClient } = renderSelector([ownPhoto, systemPhoto], {
        selectedPhotoId: 'photo-own',
        onSelect,
      });
      queryClient.setQueryData(['/vto/base-photos'], [ownPhoto, systemPhoto]);
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

      confirmDelete();

      expect(deletePhoto).toHaveBeenCalledTimes(1);
      expect(deletePhoto.mock.calls[0][0]).toEqual({ id: 'photo-own' });

      resolveDelete();

      expect(onSelect).toHaveBeenCalledWith(null);
      expect(queryClient.getQueryData(['/vto/base-photos'])).toEqual([systemPhoto]);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['/vto/base-photos'] });
    });

    it('moves focus to the selector group after a confirmed delete', () => {
      const { queryClient } = renderSelector([ownPhoto, systemPhoto], { selectedPhotoId: 'photo-own' });
      queryClient.setQueryData(['/vto/base-photos'], [ownPhoto, systemPhoto]);

      confirmDelete();
      resolveDelete();

      // The removed card's Delete control is gone; the root group survives both
      // the grid and the empty state.
      expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Base photos' }));
      expect(document.activeElement).not.toBe(document.body);
    });

    it('keeps the root group in the empty state', () => {
      renderSelector([]);

      expect(screen.getByRole('group', { name: 'Base photos' })).toBeInTheDocument();
    });

    it('keeps the card and names the try-on count when the Service refuses with a 409', () => {
      renderSelector([ownPhoto, systemPhoto]);

      confirmDelete();
      rejectDelete(rejection(409, referencedBody([{ resource: 'outfit_generation', count: 3 }])));

      const alert = expectCardSentence('This photo is used by 3 try-on(s). Delete it/them in History first.');
      // The card's own sentence, not the Service's database wording.
      expect(alert.textContent).not.toContain('outfit_generation');
      expect(screen.getByRole('button', { name: 'Delete this base photo' })).toBeInTheDocument();
      expect(screen.queryByText('Delete this base photo?')).toBeNull();
      // Focus returns to the control that can retry.
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete this base photo' }));
    });

    it('states the count-less sentence when the try-on reference carries no count', () => {
      renderSelector([ownPhoto]);

      confirmDelete();
      rejectDelete(rejection(409, referencedBody([{ resource: 'outfit_generation' }])));

      expectCardSentence('This photo is used by a try-on. Delete it in History first.');
      expect(screen.getByRole('button', { name: 'Delete this base photo' })).toBeInTheDocument();
    });

    it('keeps the Service hint verbatim for an unrecognised 409 reference', () => {
      renderSelector([ownPhoto]);

      confirmDelete();
      rejectDelete(rejection(409, referencedBody([{ resource: 'outfit' }], 'Delete the outfit that uses this photo first')));

      expectCardSentence('Delete the outfit that uses this photo first');
      expect(screen.getByRole('button', { name: 'Delete this base photo' })).toBeInTheDocument();
    });

    it('keeps the card and states the Service message for a 403', () => {
      renderSelector([ownPhoto]);

      confirmDelete();
      rejectDelete(rejection(403, { error: 'FORBIDDEN', message: 'A shared system base photo cannot be deleted' }));

      expectCardSentence('A shared system base photo cannot be deleted');
      expect(screen.getByRole('button', { name: 'Delete this base photo' })).toBeInTheDocument();
    });

    it('keeps the card and asks the user to try again after a server error', () => {
      renderSelector([ownPhoto]);

      confirmDelete();
      rejectDelete(rejection(503, { message: 'Internal Server Error' }));

      const alert = expectCardSentence('Could not remove this photo (server error 503). Try again.');
      expect(alert.textContent).not.toContain('Internal Server Error');
      expect(screen.getByRole('button', { name: 'Delete this base photo' })).toBeInTheDocument();
    });

    it('keeps the card and reports the connection when no response arrives', () => {
      renderSelector([ownPhoto]);

      confirmDelete();
      // An Axios network failure: the request exists and there is no response.
      rejectDelete({ isAxiosError: true, request: {}, message: 'Network Error' });

      expectCardSentence('Could not reach the server. Check your connection and try again.');
      expect(screen.getByRole('button', { name: 'Delete this base photo' })).toBeInTheDocument();
    });

    it('removes the row on a 404 without a sentence', () => {
      const onSelect = vi.fn();
      const { queryClient } = renderSelector([ownPhoto, systemPhoto], {
        selectedPhotoId: 'photo-own',
        onSelect,
      });
      queryClient.setQueryData(['/vto/base-photos'], [ownPhoto, systemPhoto]);
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

      confirmDelete();
      rejectDelete(rejection(404, { error: 'NOT_FOUND', message: 'Base photo not found' }));

      // The row is already gone: the requested end state holds, so the card
      // leaves with the refreshed list and reports nothing.
      expect(screen.queryByRole('alert')).toBeNull();
      expect(onSelect).toHaveBeenCalledWith(null);
      expect(queryClient.getQueryData(['/vto/base-photos'])).toEqual([systemPhoto]);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['/vto/base-photos'] });
    });

    it('renders the sentence after the media wrapper, outside the action overlay box', () => {
      renderSelector([ownPhoto]);

      confirmDelete();
      rejectDelete(rejection(409, referencedBody([{ resource: 'outfit_generation', count: 1 }])));

      const alert = screen.getByRole('alert');
      const media = screen.getByTestId('base-photo-media');
      const actions = screen.getByTestId('base-photo-actions');
      // Same card, but the sentence is a sibling of the wrapper that holds the
      // absolutely positioned overlay, so the two boxes cannot overlap.
      expect(media.contains(actions)).toBe(true);
      expect(media.contains(alert)).toBe(false);
      expect(alert.closest('article')).toBe(media.closest('article'));
      expect(alert.className).toContain('text-xs');
      expect(alert.className).toContain('text-red-500');
    });
  });

  describe('in the desktop client', () => {
    beforeEach(() => {
      stubDesktopApp();
    });

    it('renders the single Upload entry and no camera entry', () => {
      const { container } = renderSelector([]);
      const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'));

      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
      expect(inputs[0]).not.toHaveAttribute('capture');
      expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Take photo' })).toBeNull();
    });

    it('keeps the single Upload entry when the window is narrowed to 390 px', () => {
      vi.stubGlobal('innerWidth', 390);

      const { container } = renderSelector([]);
      const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'));

      expect(inputs).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Take photo' })).toBeNull();
    });
  });

  describe('in the Android app', () => {
    beforeEach(() => {
      stubAndroidApp();
    });

    it('renders both capture entries with the attributes each system path needs', () => {
      const { container } = renderSelector([]);
      const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'));

      expect(inputs).toHaveLength(2);
      // The camera entry carries `image/*`: that is the branch wry sends to
      // ACTION_IMAGE_CAPTURE, and one shot is one file.
      const camera = inputs.find((input) => input.getAttribute('accept') === 'image/*')!;
      expect(camera).toHaveAttribute('capture', 'environment');
      expect(camera).not.toHaveAttribute('multiple');
      // The library entry keeps the narrow list: it only ever opens the picker.
      const library = inputs.find((input) => input.getAttribute('accept') === 'image/jpeg,image/png,image/webp');
      expect(library).toBeDefined();
      expect(library).not.toHaveAttribute('capture');
      expect(screen.getByRole('button', { name: 'Choose from library' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Take photo' })).toBeInTheDocument();
    });

    it('reports the HEIC guidance in an alert before reserving and keeps both entries', async () => {
      const { container } = renderSelector([]);
      const library = container.querySelector<HTMLInputElement>(
        'input[accept="image/jpeg,image/png,image/webp"]',
      )!;

      // The browser omits the MIME type, so only the filename identifies the format.
      fireEvent.change(library, { target: { files: [new File(['x'], 'photo.heic')] } });

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(HEIC_UNSUPPORTED_MESSAGE);
      expect(reservePhotoUpload).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Choose from library' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Take photo' })).toBeInTheDocument();
    });

    it('shows a decode failure inline and leaves both entries available', async () => {
      vi.mocked(prepareImageForUpload).mockRejectedValueOnce(new Error('Could not process this image'));
      const { container } = renderSelector([]);
      const library = container.querySelector<HTMLInputElement>(
        'input[accept="image/jpeg,image/png,image/webp"]',
      )!;

      // A cancelled camera or picker supplies no file: no hint, no request.
      fireEvent.change(library, { target: { files: [] } });
      expect(screen.queryByRole('alert')).toBeNull();
      expect(reservePhotoUpload).not.toHaveBeenCalled();

      fireEvent.change(library, {
        target: { files: [new File(['bytes'], 'photo.jpg', { type: 'image/jpeg' })] },
      });

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Could not process this image');
      expect(reservePhotoUpload).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Choose from library' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Take photo' })).toBeInTheDocument();
    });
  });
});
