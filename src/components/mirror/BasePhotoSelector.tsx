import { useState, useRef, useLayoutEffect } from 'react';
import {
  useGetVtoBasePhotos,
  usePostVtoBasePhotosUpload,
  usePostVtoBasePhotosUploadUrl,
  usePatchVtoBasePhotosId,
  useDeleteVtoBasePhotosId,
} from '../../api/endpoints/vto/vto';
import CachedImage from '../CachedImage';
import { useQueryClient } from '@tanstack/react-query';
import { resolveImageContentType, uploadImageWithSignedPost, validateImageFile } from '../../lib/imageUpload';
import { prepareImageForUpload } from '../../lib/imagePreparation';
import type { GetVtoBasePhotos200Item } from '../../api/model/getVtoBasePhotos200Item';

interface BasePhotoSelectorProps {
  selectedPhotoId: string | null;
  onSelect: (id: string | null) => void;
  onUploaded: (id: string) => void;
}

export default function BasePhotoSelector({ selectedPhotoId, onSelect, onUploaded }: BasePhotoSelectorProps) {
  const queryClient = useQueryClient();
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const { data: photos, isLoading } = useGetVtoBasePhotos();
  const { mutateAsync: reservePhotoUpload } = usePostVtoBasePhotosUploadUrl();
  const { mutateAsync: confirmPhotoUpload } = usePostVtoBasePhotosUpload();
  const { mutate: setDefault } = usePatchVtoBasePhotosId();
  const { mutate: deletePhoto } = useDeleteVtoBasePhotosId();

  // The delete confirmation resolves after the DELETE round trip, so the clear
  // must compare against the last committed selection, not the one captured
  // when the request started: a card clicked while it is in flight stays
  // selected. This ref is refreshed after every commit.
  const selectedPhotoIdRef = useRef(selectedPhotoId);
  useLayoutEffect(() => {
    selectedPhotoIdRef.current = selectedPhotoId;
  });

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    // The system camera returns no file when the user cancels, and the WebView
    // does not fire `change` at all: a chooser that produced nothing leaves the
    // page exactly as it was, with no hint to dismiss.
    if (!file) return;

    setIsUploading(true);
    setUploadError(null);
    try {
      validateImageFile(file);
      // Orientation, scale and JPEG encoding happen before the reservation, so
      // the declared content type and the posted bytes are the prepared file's.
      const prepared = await prepareImageForUpload(file);

      // Reserve, upload through the signed policy, then confirm. The photo only
      // exists after the confirmation has read the stored object, so it cannot
      // appear in the list before its bytes are there.
      const reservation = await reservePhotoUpload({
        data: { contentType: resolveImageContentType(prepared) },
      });

      if (!reservation.upload?.url) throw new Error('Failed to reserve the upload');
      await uploadImageWithSignedPost(reservation.upload, prepared);

      const photo = await confirmPhotoUpload({
        data: { reservationId: reservation.reservationId },
      });

      queryClient.invalidateQueries({ queryKey: ['/vto/base-photos'] as const });
      // The page decides whether the confirmed photo is adopted: it keeps the
      // provenance of the current selection, which this selector cannot see.
      if (photo.id) onUploaded(photo.id);
    } catch (err) {
      console.error('Failed to upload base photo:', err);
      setUploadError(err instanceof Error ? err.message : 'Failed to upload base photo');
    } finally {
      setIsUploading(false);
      input.value = '';
    }
  };

  const handleSetDefault = (id: string) => {
    setDefault({ id, data: { is_default: true } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/vto/base-photos'] as const });
      },
    });
  };

  const handleDelete = (id: string) => {
    if (!window.confirm('Remove this base photo?')) return;
    deletePhoto({ id }, {
      onSuccess: () => {
        if (selectedPhotoIdRef.current === id) onSelect(null);
        // Drop the removed row before the refetch: the page derives its
        // selection from this list, so trimming it keeps what renders and what
        // can be selected in agreement at the next commit.
        queryClient.setQueryData<GetVtoBasePhotos200Item[]>(
          ['/vto/base-photos'],
          (cached) => (Array.isArray(cached) ? cached.filter((photo) => photo.id !== id) : cached),
        );
        queryClient.invalidateQueries({ queryKey: ['/vto/base-photos'] as const });
      },
    });
  };

  const photoList = Array.isArray(photos) ? photos : [];

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="animate-pulse bg-gray-200 rounded-lg aspect-[3/4]" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => libraryInputRef.current?.click()}
            disabled={isUploading}
            className="inline-flex items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-indigo-500 disabled:opacity-50"
          >
            <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            {isUploading ? 'Uploading...' : 'Choose from library'}
          </button>
          <button
            type="button"
            onClick={() => cameraInputRef.current?.click()}
            disabled={isUploading}
            className="inline-flex items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-indigo-500 disabled:opacity-50"
          >
            <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.66-.9l.82-1.2A2 2 0 0110.07 4h3.86a2 2 0 011.66.9l.82 1.2a2 2 0 001.66.9H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Take photo
          </button>
        </div>
        <input
          ref={libraryInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={handleFileChange}
        />
        <input
          ref={cameraInputRef}
          type="file"
          // `image/*` is the branch wry sends to ACTION_IMAGE_CAPTURE; with only
          // JPEG/PNG/WebP listed it opens the system file picker instead.
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={handleFileChange}
        />
        {photoList.length > 0 && (
          <span className="text-xs text-gray-500">{photoList.length} photo{photoList.length !== 1 ? 's' : ''}</span>
        )}
      </div>
      {uploadError && (
        <p className="mb-3 text-sm text-red-600" role="alert">{uploadError}</p>
      )}

      {photoList.length === 0 ? (
        <div className="bg-gray-50 rounded-lg border-2 border-dashed border-gray-300 p-6 text-center">
          <svg className="mx-auto h-10 w-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <p className="mt-2 text-sm text-gray-500">Upload your first mannequin photo to get started</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {photoList.map((photo, index) => {
            // `userId` is null exactly for the shared system photo. It can be the
            // effective default (the API flags the caller's pointer), so it renders
            // like any other photo except that it cannot be deleted.
            const isSystemPhoto = photo.userId === null;
            const kindLabel = photo.isDefault ? 'Default photo' : isSystemPhoto ? 'System photo' : 'Base photo';
            return (
            <article
              key={photo.id}
              className={`relative group overflow-hidden rounded-xl border transition-colors ${
                selectedPhotoId === photo.id
                  ? 'border-indigo-600 ring-1 ring-indigo-600'
                  : 'border-gray-200 hover:border-gray-400'
              }`}
            >
              <button type="button" aria-pressed={selectedPhotoId === photo.id} aria-label={`${selectedPhotoId === photo.id ? 'Selected' : 'Select'} base photo ${index + 1}${photo.isDefault ? ', default' : ''}${isSystemPhoto ? ', shared system photo' : ''}`} onClick={() => onSelect(photo.id)} className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-600">
                {photo.url ? (
                  <CachedImage
                    src={photo.url}
                    cacheKey={`vto-base-${photo.imageId}`}
                    alt=""
                    className="aspect-[4/5] w-full object-cover"
                  />
                ) : (
                  <div className="aspect-[4/5] w-full bg-gray-100" aria-hidden="true" />
                )}
                <span className="absolute left-2 top-2 rounded-full bg-white/95 px-2 py-1 text-xs font-medium text-gray-800 shadow-sm">
                  {kindLabel}{selectedPhotoId === photo.id ? ' · Selected' : ''}
                </span>
              </button>
              {photo.isDefault && (
                <span className="sr-only">Default photo</span>
              )}
              <div className="absolute inset-x-0 bottom-0 flex justify-center gap-1 bg-gradient-to-t from-black/60 to-transparent p-2 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                {!photo.isDefault && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleSetDefault(photo.id); }}
                    aria-label="Set this photo as default"
                    className="rounded bg-white px-2 py-1 text-xs text-gray-800 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                  >
                    Set Default
                  </button>
                )}
                {!isSystemPhoto && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(photo.id); }}
                      aria-label="Delete this base photo"
                      className="rounded bg-red-700 px-2 py-1 text-xs text-white hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                  >
                    <svg className="w-3 h-3 inline mr-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                    Delete
                  </button>
                )}
              </div>
            </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
