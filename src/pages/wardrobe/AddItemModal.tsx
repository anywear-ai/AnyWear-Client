import { useState, useRef, useMemo, useEffect } from 'react';
import { usePostWardrobeUploadUrl, usePostWardrobeUpload } from '../../api/endpoints/wardrobe/wardrobe';
import { uploadImageWithSignedPost, resolveImageContentType } from '../../lib/imageUpload';
import {
  createBatchPhotos,
  planBatch,
  runBatch,
  type BatchPhoto,
  type BatchPhotoStatus,
  type BatchUploadDeps,
  type BatchRun,
} from '../../lib/batchUpload';
import useAccessibleDialog from '../../hooks/useAccessibleDialog';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  /**
   * The page's live wardrobe items. A created row reads its item's tagging status
   * from here, so the batch rides the page's existing polling and status stream
   * instead of adding an endpoint or a polling interval of its own.
   */
  items?: Array<{ id: string; taggingStatus: string; taggingErrorCode?: string | null }>;
  /** Called after each confirmation so the page can refresh its list. */
  onItemsCreated?: () => void;
}

function statusBadgeClass(status: BatchPhotoStatus): string {
  const pill = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium';
  switch (status) {
    case 'queued':
      return `${pill} bg-blue-100 text-blue-800`;
    case 'preparing':
    case 'reserving':
    case 'uploading':
    case 'confirming':
      return `${pill} bg-yellow-100 text-yellow-800`;
    case 'created':
      return `${pill} bg-gray-100 text-gray-700`;
    case 'failed':
      return `${pill} bg-red-100 text-red-800`;
  }
}

function statusLabel(status: BatchPhotoStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'preparing':
      return 'Preparing';
    case 'reserving':
      return 'Reserving';
    case 'uploading':
      return 'Uploading';
    case 'confirming':
      return 'Confirming';
    case 'created':
      return 'Created';
    case 'failed':
      return 'Failed';
  }
}

/** A created row states its item's live tagging status, code included when it failed. */
function taggingLabel(
  fallback: string | undefined,
  item: { taggingStatus: string; taggingErrorCode?: string | null } | undefined,
): string | null {
  const status = item?.taggingStatus ?? fallback;
  if (!status) return null;
  if (status === 'failed') {
    return item?.taggingErrorCode ? `Tagging failed (${item.taggingErrorCode})` : 'Tagging failed';
  }
  return `Tagging ${status}`;
}

export default function AddItemModal({ isOpen, onClose, onSuccess, items, onItemsCreated }: Props) {
  const [photos, setPhotos] = useState<BatchPhoto[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [boundMessage, setBoundMessage] = useState<string | null>(null);
  const [duplicateMessage, setDuplicateMessage] = useState<string | null>(null);
  const runRef = useRef<BatchRun | null>(null);
  const onItemsCreatedRef = useRef(onItemsCreated);
  const dialogRef = useAccessibleDialog(handleClose, isOpen);

  const { mutateAsync: getUploadUrl } = usePostWardrobeUploadUrl();
  const { mutateAsync: confirmUpload } = usePostWardrobeUpload();

  function handleClose() {
    runRef.current?.cancel();
    onClose();
  }

  useEffect(() => {
    onItemsCreatedRef.current = onItemsCreated;
  });

  // Closing the dialog stops photos that have not started and lets the in-flight
  // ones settle; unmounting must never leave an unhandled rejection behind.
  useEffect(() => () => {
    runRef.current?.cancel();
  }, []);

  const itemStatusById = useMemo(() => {
    const map = new Map<string, { taggingStatus: string; taggingErrorCode?: string | null }>();
    for (const item of items ?? []) map.set(item.id, item);
    return map;
  }, [items]);

  if (!isOpen) return null;

  const deps: BatchUploadDeps = {
    reserve: async (file) => {
      const reservation = await getUploadUrl({ data: { contentType: resolveImageContentType(file) } });
      return { reservationId: reservation.reservationId, upload: reservation.upload };
    },
    postBytes: (upload, file) => uploadImageWithSignedPost(upload, file),
    confirm: async (reservationId) => {
      const confirmation = await confirmUpload({ data: { reservationId } });
      return { itemId: confirmation.itemId, taggingStatus: confirmation.taggingStatus };
    },
  };

  const addFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const incoming = Array.from(files);
    // The bound and the duplicate collapse run over the whole list, not just the
    // files this activation added: the camera appends one shot at a time.
    const plan = planBatch([...photos.map((photo) => photo.file), ...incoming]);
    const kept = new Set(plan.files);
    setPhotos((previous) => [
      ...previous.filter((photo) => kept.has(photo.file)),
      ...createBatchPhotos(incoming.filter((file) => kept.has(file))),
    ]);
    setBoundMessage(plan.message);
    setDuplicateMessage(plan.duplicateMessage);
  };

  const runPhotos = async (targets: BatchPhoto[]) => {
    if (targets.length === 0) return;
    const latest = new Map(targets.map((photo) => [photo.id, photo]));
    setIsRunning(true);
    const run = runBatch(targets, deps, (updated) => {
      latest.set(updated.id, updated);
      setPhotos((previous) => previous.map((photo) => (photo.id === updated.id ? updated : photo)));
      if (updated.status === 'created') onItemsCreatedRef.current?.();
    });
    runRef.current = run;
    try {
      await run.settled;
    } finally {
      runRef.current = null;
      setIsRunning(false);
    }
    if (run.cancelled) return;

    // One photo keeps the single-photo contract, on Retry as well: success closes
    // the dialog through onSuccess, a failure raises the existing alert and the
    // dialog stays open.
    if (photos.length === 1 && targets.length === 1) {
      const settledPhoto = latest.get(targets[0].id);
      if (settledPhoto?.status === 'created') {
        onSuccess();
      } else if (settledPhoto?.status === 'failed') {
        alert(`Failed to upload image: ${settledPhoto.error ?? 'Unknown error'}`);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isRunning || photos.length === 0) return;

    // Applied again at submit, not only at selection.
    const plan = planBatch(photos.map((photo) => photo.file));
    const kept = new Set(plan.files);
    const targets = photos.filter((photo) => kept.has(photo.file));
    if (targets.length !== photos.length) setPhotos(targets);
    setBoundMessage(plan.message);
    setDuplicateMessage(plan.duplicateMessage);
    await runPhotos(targets);
  };

  const handleRetryFailed = () => {
    if (isRunning) return;
    const targets = photos.filter((photo) => photo.status === 'failed');
    if (targets.length === 0) return;
    void runPhotos(targets);
  };

  const removePhoto = (id: string) => {
    const remaining = photos.filter((photo) => photo.id !== id);
    // The bound and duplicate messages describe the selection that produced the
    // list, so they are recomputed from the rows that remain; a message that no
    // longer applies is cleared instead of describing a photo the user removed.
    const plan = planBatch(remaining.map((photo) => photo.file));
    setPhotos(remaining);
    setBoundMessage(plan.message);
    setDuplicateMessage(plan.duplicateMessage);
  };

  const settled = photos.length > 0
    && photos.every((photo) => photo.status === 'created' || photo.status === 'failed');
  const createdCount = photos.filter((photo) => photo.status === 'created').length;
  const failedCount = photos.filter((photo) => photo.status === 'failed').length;
  const summary = settled && photos.length > 1
    ? `${createdCount} item${createdCount === 1 ? '' : 's'} added, ${failedCount} failed`
    : null;
  const showRetry = settled && failedCount > 0;
  const primaryLabel = isRunning && photos.length === 1
    ? 'Uploading...'
    : photos.length > 1
      ? `Add ${photos.length} items`
      : 'Upload & Auto-Tag';
  // A disabled input refuses the picker, and its wrapping label carries the busy
  // affordance because a label has no disabled state of its own. The
  // `focus-within:` ring tokens stay unconditional: every focusable stop in the
  // dialog keeps the ring, disabled controls included.
  const fileInputLabelClass = `relative bg-white rounded-md font-medium text-indigo-600 hover:text-indigo-500 focus-within:outline-none focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-indigo-500 ${isRunning ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`;

  return (
    <div className="fixed inset-0 z-10 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:p-0">
        <div className="fixed inset-0 transition-opacity bg-gray-500/75" onClick={handleClose} />

        <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="add-item-title" tabIndex={-1} className="relative inline-block px-4 pt-5 pb-4 overflow-hidden text-left align-bottom transition-all transform bg-white rounded-xl shadow-xl sm:my-8 sm:align-middle sm:max-w-lg sm:w-full sm:p-6">
          <div className="absolute top-0 right-0 pt-4 pr-4">
            <button
              onClick={handleClose}
              className="text-gray-400 bg-white rounded-md hover:text-gray-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              <span className="sr-only">Close</span>
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="sm:flex sm:items-start">
            <div className="w-full mt-3 text-center sm:mt-0 sm:text-left">
              <h3 id="add-item-title" className="text-lg font-medium leading-6 text-gray-900">Add Wardrobe Item</h3>
              <p className="mt-1 text-sm text-gray-500">
                Upload a photo and AI will automatically tag the item with category, color, material, and more.
              </p>

              <form onSubmit={handleSubmit} className="mt-6 space-y-4">
                <div>
                  <label htmlFor="add-item-image" className="block text-sm font-medium text-gray-700">Image</label>
                  <div className="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-gray-300 border-dashed rounded-md">
                    <div className="space-y-1 text-center">
                      <svg className="mx-auto h-12 w-12 text-gray-400" stroke="currentColor" fill="none" viewBox="0 0 48 48">
                        <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm text-gray-600">
                        <label className={fileInputLabelClass}>
                          <span>Choose from library</span>
                          <input
                            id="add-item-image"
                            type="file"
                            multiple
                            disabled={isRunning}
                            accept="image/jpeg,image/png,image/webp"
                            className="sr-only"
                            onChange={(e) => {
                              addFiles(e.target.files);
                              e.target.value = '';
                            }}
                          />
                        </label>
                        <label className={fileInputLabelClass}>
                          <span>Take photo</span>
                          <input
                            id="add-item-camera"
                            type="file"
                            disabled={isRunning}
                            // `image/*` is what makes wry take the camera branch:
                            // with only JPEG/PNG/WebP listed it opens the file picker.
                            accept="image/*"
                            capture="environment"
                            className="sr-only"
                            onChange={(e) => {
                              addFiles(e.target.files);
                              e.target.value = '';
                            }}
                          />
                        </label>
                      </div>
                      <p className="text-xs text-gray-500">PNG, JPG or WebP up to 30MB</p>
                    </div>
                  </div>

                  {boundMessage && <p className="mt-2 text-sm text-gray-500">{boundMessage}</p>}
                  {duplicateMessage && <p className="mt-1 text-sm text-gray-500">{duplicateMessage}</p>}

                  {photos.length > 0 && (
                    <ul aria-label="Added photos" className="mt-4 space-y-2">
                      {photos.map((photo) => {
                        const liveItem = photo.itemId ? itemStatusById.get(photo.itemId) : undefined;
                        const tagStatus = photo.status === 'created'
                          ? taggingLabel(photo.taggingStatus, liveItem)
                          : null;
                        return (
                          <li
                            key={photo.id}
                            data-status={photo.status}
                            className="flex items-start justify-between gap-2 rounded-md border border-gray-200 px-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm text-gray-700">{photo.file.name}</p>
                              <p className="mt-1 flex flex-wrap items-center gap-2">
                                <span className={statusBadgeClass(photo.status)}>{statusLabel(photo.status)}</span>
                                {photo.status === 'created' && photo.itemId && (
                                  <span className="break-all text-xs text-gray-500">Item {photo.itemId}</span>
                                )}
                                {tagStatus && <span className="text-xs text-gray-500">{tagStatus}</span>}
                              </p>
                              {photo.status === 'failed' && photo.error && (
                                <p className="mt-1 text-xs text-red-500">{photo.error}</p>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => removePhoto(photo.id)}
                              // While the batch runs, every row is one of the run's
                              // targets; removing it would leave the run uploading a
                              // photo the list no longer shows.
                              disabled={isRunning || photo.status === 'created'}
                              aria-label={`Remove ${photo.file.name}`}
                              className="rounded-md p-1 text-gray-400 hover:text-gray-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {summary && <p role="status" className="mt-2 text-sm text-gray-700">{summary}</p>}

                  {showRetry && (
                    <button
                      type="button"
                      onClick={handleRetryFailed}
                      className="mt-2 inline-flex justify-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                    >
                      Retry failed
                    </button>
                  )}
                </div>

                <div className="mt-5 sm:mt-4 sm:flex sm:flex-row-reverse">
                  <button
                    type="submit"
                    disabled={isRunning || photos.length === 0}
                    className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-indigo-600 text-base font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 sm:ml-3 sm:w-auto sm:text-sm disabled:opacity-50"
                  >
                    {primaryLabel}
                  </button>
                  <button
                    type="button"
                    onClick={handleClose}
                    className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 sm:mt-0 sm:w-auto sm:text-sm"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
