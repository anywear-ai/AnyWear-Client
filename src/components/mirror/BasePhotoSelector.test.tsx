// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
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
    vi.restoreAllMocks();
  });

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

  it('shows a decode failure inline and leaves the library entry as the retry', async () => {
    vi.mocked(prepareImageForUpload).mockRejectedValueOnce(new Error('Could not process this image'));
    const { container } = renderSelector([]);
    const library = container.querySelector<HTMLInputElement>('input[type="file"]')!;

    // A cancelled picker supplies no file: no hint, no request.
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

  it('trims the deleted row from the cached list and clears the selection with null', () => {
    const onSelect = vi.fn();
    const { queryClient } = renderSelector([ownPhoto, systemPhoto], {
      selectedPhotoId: 'photo-own',
      onSelect,
    });
    queryClient.setQueryData(['/vto/base-photos'], [ownPhoto, systemPhoto]);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    fireEvent.click(screen.getByRole('button', { name: 'Delete this base photo' }));

    expect(deletePhoto).toHaveBeenCalledTimes(1);
    const [variables, options] = deletePhoto.mock.calls[0];
    expect(variables).toEqual({ id: 'photo-own' });

    act(() => options.onSuccess());

    expect(onSelect).toHaveBeenCalledWith(null);
    expect(queryClient.getQueryData(['/vto/base-photos'])).toEqual([systemPhoto]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['/vto/base-photos'] });
  });
});
