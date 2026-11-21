import { useState, useRef } from 'react';
import { usePatchWardrobeItemsId, usePostWardrobeItemsItemIdArchive, usePostWardrobeItemsItemIdRestore, usePostWardrobeItemsItemIdRetag } from '../../api/endpoints/wardrobe/wardrobe';
import { GetWardrobe200Item } from '../../api/model/getWardrobe200Item';
import type { PostWardrobeItemsIdUpload200 } from '../../api/model/postWardrobeItemsIdUpload200';
import type { PostWardrobeItemsIdUploadUrl200 } from '../../api/model/postWardrobeItemsIdUploadUrl200';
import CachedImage from '../../components/CachedImage';
import { AXIOS_INSTANCE } from '../../api/custom-instance';
import { resolveImageContentType, uploadImageWithSignedPost, validateImageFile } from '../../lib/imageUpload';
import { prepareImageForUpload } from '../../lib/imagePreparation';
import { getErrorMessage } from '../../lib/errors';
import { describeWardrobeItemLifecycleFailure } from '../../lib/wardrobeItemDeleteFailure';
import useAccessibleDialog from '../../hooks/useAccessibleDialog';
import { isAndroidApp } from '../../lib/platform';
import { isClientVersionRefused } from '../../store/clientVersionRefusalStore';

/** #140's terminal code: the provider cannot decode the stored image format. */
const INPUT_IMAGE_UNSUPPORTED_FORMAT_CODE = 'input_image_unsupported_format';

interface Props {
  item: GetWardrobe200Item | null;
  isOpen: boolean;
  onClose: () => void;
  /** An update succeeded: the dialog's caller refreshes the list. */
  onSuccess: () => void;
  /**
   * The delete finished. `deleted` removes the row; `already-gone` additionally
   * states the removal in the page notice, because a `404` is not a failure.
   */
  onDeleted: (outcome: 'deleted' | 'already-gone') => void;
  /** A re-tag started: its message outlives this dialog in the page notice. */
  onRetagStarted: () => void;
}

/** One gallery entry as this editor holds it: the read's members plus its own draft flags. */
interface EditableImage {
  imageId: string;
  url: string | null;
  view: string | null;
  isPrimary: boolean;
}

interface StyleAttributeFields {
  color: string;
  material: string;
  design: string;
  fit: string;
  pattern: string;
  neckline: string;
  sleeveLength: string;
  pockets: string;
  hemline: string;
  vibe: string;
  brand: string;
}

function parseStyleAttributes(raw: unknown): StyleAttributeFields {
  const defaults: StyleAttributeFields = { color: '', material: '', design: '', fit: '', pattern: '', neckline: '', sleeveLength: '', pockets: '', hemline: '', vibe: '', brand: '' };
  if (!raw) return defaults;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (typeof obj !== 'object' || !obj) return defaults;
    return {
      color: String(obj.color ?? ''), material: String(obj.material ?? ''), design: String(obj.design ?? ''),
      fit: String(obj.fit ?? ''), pattern: String(obj.pattern ?? ''), neckline: String(obj.neckline ?? ''),
      sleeveLength: String(obj.sleeveLength ?? ''), pockets: String(obj.pockets ?? ''), hemline: String(obj.hemline ?? ''),
      vibe: String(obj.vibe ?? ''), brand: String(obj.brand ?? ''),
    };
  } catch {
    return defaults;
  }
}

function parseWeatherTags(raw: unknown): string[] {
  if (!raw) return [];
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr.filter((t: unknown) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

const ATTRIBUTE_FIELDS: { key: keyof StyleAttributeFields; label: string; placeholder: string }[] = [
  { key: 'color', label: 'Color', placeholder: 'e.g. Black, White' },
  { key: 'material', label: 'Material', placeholder: 'e.g. Cotton' },
  { key: 'design', label: 'Design', placeholder: 'e.g. Short-sleeve Pullover' },
  { key: 'fit', label: 'Fit', placeholder: 'e.g. Slim, Regular, Oversized' },
  { key: 'pattern', label: 'Pattern', placeholder: 'e.g. Solid, Striped, Floral' },
  { key: 'neckline', label: 'Neckline', placeholder: 'e.g. Crew Neck, V-Neck' },
  { key: 'sleeveLength', label: 'Sleeve Length', placeholder: 'e.g. Short, Long' },
  { key: 'pockets', label: 'Pockets', placeholder: 'e.g. No Pockets, Side Pockets' },
  { key: 'hemline', label: 'Hemline', placeholder: 'e.g. Straight' },
  { key: 'vibe', label: 'Vibe', placeholder: 'e.g. Casual, Formal' },
  { key: 'brand', label: 'Brand', placeholder: 'e.g. Nike' },
];

const VIEW_OPTIONS = ['', 'front', 'back', 'side', 'detail', 'tag'];

export default function ItemDetailsModal({ item, isOpen, onClose, onSuccess, onDeleted, onRetagStarted }: Props) {
  if (!isOpen || !item) return null;

  return (
    <ItemDetailsEditor
      key={item.id}
      item={item}
      onClose={onClose}
      onSuccess={onSuccess}
      onDeleted={onDeleted}
      onRetagStarted={onRetagStarted}
    />
  );
}

interface ItemDetailsEditorProps {
  item: GetWardrobe200Item;
  onClose: () => void;
  onSuccess: () => void;
  onDeleted: (outcome: 'deleted' | 'already-gone') => void;
  onRetagStarted: () => void;
}

function ItemDetailsEditor({ item, onClose, onSuccess, onDeleted, onRetagStarted }: ItemDetailsEditorProps) {
  const [name, setName] = useState(item.name || '');
  const [category, setCategory] = useState(item.category || '');
  const [attrs, setAttrs] = useState<StyleAttributeFields>(() => parseStyleAttributes(item.styleAttributes));
  const [weatherTagsInput, setWeatherTagsInput] = useState(() => parseWeatherTags(item.weatherTags).join(', '));
  const [images, setImages] = useState<EditableImage[]>(() => item.images.map((image) => ({
    imageId: image.imageId,
    url: image.url,
    view: image.view,
    isPrimary: image.isPrimary,
  })));
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [isAddingImage, setIsAddingImage] = useState(false);
  const [addImageError, setAddImageError] = useState<string | null>(null);
  // The in-place delete question, the sentence a refused delete leaves inside it,
  // and the update/re-tag failure the action row prints above itself.
  // Issue 332 — the details dialog offers the item lifecycle transition, never a
  // raw delete: a permanent delete is reachable only from the Storage Box, through
  // the page dependent-outfit confirmation. This surface archives (or restores)
  // the item, which is the active view one destructive action.
  const [lifecycleFailure, setLifecycleFailure] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const { mutateAsync: updateItem, isPending: isUpdating } = usePatchWardrobeItemsId();
  const { mutateAsync: archiveItem, isPending: isArchiving } = usePostWardrobeItemsItemIdArchive();
  const { mutateAsync: restoreItem, isPending: isRestoring } = usePostWardrobeItemsItemIdRestore();
  const { mutateAsync: retagItem, isPending: isRetagging } = usePostWardrobeItemsItemIdRetag();

  // Every close path — Escape, the backdrop, the close control and Cancel — runs
  // through this guard, so an in-flight lifecycle change keeps its surface and its
  // outcome always has somewhere to land.
  const requestClose = () => {
    if (isArchiving || isRestoring) return;
    onClose();
  };

  const dialogRef = useAccessibleDialog(requestClose);

  const currentImage = images[selectedImageIndex];

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!item.id) return;

    const tags = weatherTagsInput.split(',').map((t) => t.trim()).filter(Boolean);
    const styleAttributes: Record<string, string> = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (v) styleAttributes[k] = v;
    }

    setActionError(null);
    try {
      await updateItem({
        id: item.id,
        data: {
          name: name || undefined,
          category: category || undefined,
          // The write body names images, never a key or a URL: the value the
          // Client read is not re-encoded on the way back.
          images: images.length > 0 ? images.map(({ imageId, view, isPrimary }) => ({
            imageId,
            ...(view ? { view } : {}),
            isPrimary,
          })) : undefined,
          styleAttributes: Object.keys(styleAttributes).length > 0 ? styleAttributes : undefined,
          weatherTags: tags.length > 0 ? tags : undefined,
        },
      });
      onSuccess();
    } catch (error) {
      console.error('Failed to update item:', error);
      // A sentence written after the shell is replaced would paint over the
      // blocking refusal screen. The guard reads the one global state; it is not
      // a recogniser.
      if (isClientVersionRefused()) return;
      setActionError('Failed to update item');
    }
  };

  /**
   * Issue 332 — the dialog's destructive action is the Storage Box transition.
   * Archiving hides the item without touching any outfit that lists it; restoring
   * puts it back. A permanent delete lives only in the Storage Box view.
   */
  const handleArchiveToggle = async () => {
    if (!item.id) return;
    setLifecycleFailure(null);
    try {
      if (item.archivedAt) await restoreItem({ itemId: item.id });
      else await archiveItem({ itemId: item.id });
    } catch (error) {
      console.error('Failed to change the item lifecycle:', error);
      if (isClientVersionRefused()) return;
      setLifecycleFailure(describeWardrobeItemLifecycleFailure(error, item.archivedAt ? 'restore' : 'archive'));
      return;
    }
    // The item leaves the view it was in, so the dialog closes and the page re-reads.
    onDeleted('deleted');
  };
  const handleRetag = async () => {
    if (!item.id) return;
    setActionError(null);
    try {
      await retagItem({ itemId: item.id });
      onRetagStarted();
    } catch (error) {
      console.error('Failed to re-tag item:', error);
      if (isClientVersionRefused()) return;
      setActionError('Failed to start re-tagging');
    }
  };

  const handleViewChange = (index: number, value: string) => {
    setImages((prev) => {
      const copy = [...prev];
      if (copy[index]) copy[index] = { ...copy[index], view: value || null };
      return copy;
    });
  };

  const handleSetPrimary = (index: number) => {
    setImages((prev) => prev.map((img, i) => ({ ...img, isPrimary: i === index ? true : false })));
  };

  const handleRemoveImage = (index: number) => {
    setImages((prev) => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length > 0 && next.every((img) => img.isPrimary !== true)) {
        next[0] = { ...next[0], isPrimary: true };
      }
      return next;
    });
    setSelectedImageIndex((prev) => {
      if (index === prev) return 0;
      if (index < prev) return prev - 1;
      return prev;
    });
  };

  const handleAddImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    // A cancelled camera or picker supplies no file: nothing changed, so no hint
    // is raised and both entries stay available.
    if (!file || !item.id) return;

    setIsAddingImage(true);
    setAddImageError(null);
    try {
      validateImageFile(file);
      // The orientation is baked and the bytes re-encoded before the reservation,
      // so the declared content type and the stored object agree.
      const prepared = await prepareImageForUpload(file);

      // Reserve the additional image, upload it through the signed policy, then
      // confirm. The confirmation returns the image record it attached, so the
      // gallery paints the signed download URL until the next read returns a
      // fresh `url`, and the PATCH that saves this list carries image ids only.
      const { data: reservation } = await AXIOS_INSTANCE.post<PostWardrobeItemsIdUploadUrl200>(
        `/wardrobe/items/${item.id}/upload-url`,
        { contentType: resolveImageContentType(prepared) },
      );

      if (!reservation?.upload?.url) throw new Error('Failed to reserve the upload');

      await uploadImageWithSignedPost(reservation.upload, prepared);

      const { data: confirmed } = await AXIOS_INSTANCE.post<PostWardrobeItemsIdUpload200>(
        `/wardrobe/items/${item.id}/upload`,
        { reservationId: reservation.reservationId },
      );

      setImages((prev) => [...prev, {
        imageId: confirmed.imageId,
        url: confirmed.downloadUrl,
        view: null,
        isPrimary: prev.length === 0,
      }]);
      setSelectedImageIndex(images.length);
    } catch (error) {
      console.error('Failed to add image:', error);
      // The cause stays inline: a decode failure or an unreadable format is a
      // hint next to the two entries, not a dialog the user has to dismiss.
      setAddImageError(getErrorMessage(error, 'Failed to upload additional image'));
    } finally {
      setIsAddingImage(false);
      input.value = '';
    }
  };

  const isProcessing = item.taggingStatus === 'processing' || item.taggingStatus === 'uploading';
  const isUnsupportedFormatFailure =
    item.taggingStatus === 'failed' && item.taggingErrorCode === INPUT_IMAGE_UNSUPPORTED_FORMAT_CODE;
  // The platform, never the window width, decides whether the gallery footer
  // offers the Android pair or the web build's one `+` tile.
  const android = isAndroidApp();

  return (
    <div className="fixed inset-0 z-10 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:p-0">
        <div className="fixed inset-0 transition-opacity bg-gray-500/75" onClick={requestClose} />

        <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="item-details-title" tabIndex={-1} className="relative inline-block px-4 pt-5 pb-4 overflow-hidden text-left align-bottom transition-all transform bg-white rounded-xl shadow-xl sm:my-8 sm:align-middle sm:max-w-lg sm:w-full sm:p-6">
          <div className="absolute top-0 right-0 pt-4 pr-4">
            <button onClick={requestClose} disabled={isArchiving || isRestoring} className="text-gray-400 bg-white rounded-md hover:text-gray-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50">
              <span className="sr-only">Close</span>
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="sm:flex sm:items-start">
            <div className="w-full mt-3 text-center sm:mt-0 sm:text-left">
              <div className="flex items-center justify-between">
                <h3 id="item-details-title" className="text-lg font-medium leading-6 text-gray-900">Item Details</h3>
                {item.taggingStatus === 'failed' && (
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                    Tagging Failed
                  </span>
                )}
                {isProcessing && (
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                    Analyzing...
                  </span>
                )}
              </div>

              {isUnsupportedFormatFailure && item.taggingErrorMessage && (
                <p className="mt-2 text-sm text-red-600" role="alert">{item.taggingErrorMessage}</p>
              )}

              {/* Image gallery */}
              <div className="mt-4">
                <div className="flex justify-center">
                  {currentImage?.url ? (
                    <CachedImage src={currentImage.url} cacheKey={currentImage.imageId} alt="Item" className="max-h-64 object-contain rounded-md" />
                  ) : (
                    <div className="flex items-center justify-center h-48 w-full bg-gray-100 text-gray-400 rounded-md">
                      No Image
                    </div>
                  )}
                </div>

                {/* Per-image controls: view + primary */}
                {currentImage && (
                  <div className="mt-2 flex items-center gap-3 justify-center text-xs">
                    <label htmlFor="item-details-view" className="text-gray-600">View</label>
                    <select
                      id="item-details-view"
                      value={currentImage.view || ''}
                      onChange={(e) => handleViewChange(selectedImageIndex, e.target.value)}
                      className="border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                    >
                      {VIEW_OPTIONS.map((v) => (
                        <option key={v} value={v}>{v || '(no view)'}</option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1 text-gray-600 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={currentImage.isPrimary === true}
                        onChange={() => handleSetPrimary(selectedImageIndex)}
                        className="rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      Primary
                    </label>
                  </div>
                )}

                {/* Thumbnail row */}
                {images.length > 0 && (
                  <div className="mt-3 flex gap-2 justify-center">
                    {images.map((img, idx) => (
                      <div key={idx} className="relative">
                        <button
                          type="button"
                          aria-label={`Show image ${idx + 1}`}
                          onClick={() => setSelectedImageIndex(idx)}
                          className={`w-16 h-16 rounded border-2 overflow-hidden flex-shrink-0 transition focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 ${idx === selectedImageIndex ? 'border-indigo-500' : 'border-gray-200 hover:border-gray-400'}`}
                        >
                          {img.url ? (
                            <CachedImage src={img.url} cacheKey={img.imageId} alt={`Image ${idx + 1}`} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full bg-gray-100" />
                          )}
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove image ${idx + 1}`}
                          onClick={(e) => { e.stopPropagation(); handleRemoveImage(idx); }}
                          className="absolute -top-1.5 -right-1.5 bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px] leading-none hover:bg-red-600 transition focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* The platform decides the entry row: the web build and the desktop
                  client keep one `+` tile, Android keeps its pair. The tile sits
                  outside the gallery list, so an item with no images can still
                  gain its first one. */}
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                {android ? (
                  <>
                    <button
                      type="button"
                      onClick={() => libraryInputRef.current?.click()}
                      disabled={isAddingImage}
                      className="inline-flex justify-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
                    >
                      {isAddingImage ? 'Uploading...' : 'Choose from library'}
                    </button>
                    <button
                      type="button"
                      onClick={() => cameraInputRef.current?.click()}
                      disabled={isAddingImage}
                      className="inline-flex justify-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
                    >
                      Take photo
                    </button>
                    <input
                      ref={libraryInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      onChange={handleAddImage}
                    />
                    <input
                      ref={cameraInputRef}
                      type="file"
                      // `image/*` is the branch wry sends to ACTION_IMAGE_CAPTURE;
                      // with only JPEG/PNG/WebP listed it opens the file picker.
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      onChange={handleAddImage}
                    />
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      aria-label="Add image"
                      onClick={() => libraryInputRef.current?.click()}
                      disabled={isAddingImage}
                      className="w-16 h-16 rounded border-2 border-dashed border-gray-300 flex items-center justify-center text-gray-400 hover:border-gray-500 hover:text-gray-600 transition flex-shrink-0 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                    >
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                      </svg>
                    </button>
                    <input
                      ref={libraryInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      onChange={handleAddImage}
                    />
                  </>
                )}
              </div>
              {addImageError && (
                <p className="mt-2 text-sm text-red-600" role="alert">{addImageError}</p>
              )}

              <form onSubmit={handleUpdate} className="mt-4 space-y-3 max-h-[50vh] overflow-y-auto">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="item-details-name" className="block text-xs font-medium text-gray-700">Name</label>
                    <input type="text" id="item-details-name" value={name} onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. My favorite hoodie"
                      className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-1.5 px-2 text-sm focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500 focus:border-indigo-500" />
                  </div>
                  <div>
                    <label htmlFor="item-details-category" className="block text-xs font-medium text-gray-700">Category<span aria-hidden="true"> *</span></label>
                    <input type="text" id="item-details-category" value={category} onChange={(e) => setCategory(e.target.value)}
                      placeholder="e.g. Top"
                      className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-1.5 px-2 text-sm focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500 focus:border-indigo-500" />
                  </div>
                </div>

                {ATTRIBUTE_FIELDS.map(({ key, label, placeholder }) => (
                  <div key={key}>
                    <label htmlFor={`item-details-attr-${key}`} className="block text-xs font-medium text-gray-700">
                      {label}{(key === 'color' || key === 'material') && <span aria-hidden="true"> *</span>}
                    </label>
                    <input type="text" id={`item-details-attr-${key}`} value={attrs[key]} onChange={(e) => setAttrs((prev) => ({ ...prev, [key]: e.target.value }))}
                      placeholder={placeholder}
                      className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-1.5 px-2 text-sm focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500 focus:border-indigo-500" />
                  </div>
                ))}

                <div>
                  <label htmlFor="item-details-weather-tags" className="block text-xs font-medium text-gray-700">Weather Tags</label>
                  <input type="text" id="item-details-weather-tags" value={weatherTagsInput}
                    onChange={(e) => setWeatherTagsInput(e.target.value)}
                    placeholder="e.g. Cold, Windy, Warm"
                    className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-1.5 px-2 text-sm focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500 focus:border-indigo-500" />
                  <p className="mt-0.5 text-xs text-gray-400">Comma-separated</p>
                </div>

                {actionError && (
                  <p role="alert" className="mt-2 text-sm text-red-600">{actionError}</p>
                )}

                <div className="flex flex-wrap gap-2 pt-3 border-t">
                  <button type="submit" disabled={isUpdating || isProcessing}
                    className="inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-indigo-600 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500 disabled:opacity-50">
                    {isUpdating ? 'Saving...' : 'Save Changes'}
                  </button>
                  {!isUnsupportedFormatFailure && (
                    <button type="button" disabled={isRetagging || isProcessing}
                      onClick={handleRetag}
                      className="inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500 disabled:opacity-50">
                      {isRetagging ? 'Re-tagging...' : 'Re-tag'}
                    </button>
                  )}
                  <button ref={deleteButtonRef} type="button" disabled={isArchiving || isRestoring}
                    data-testid="item-lifecycle-action"
                    onClick={handleArchiveToggle}
                    className="inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-gray-800 text-sm font-medium text-white hover:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500 disabled:opacity-50">
                    {isArchiving ? 'Archiving...' : isRestoring ? 'Restoring...' : item.archivedAt ? 'Restore' : 'Archive'}
                  </button>
                  {lifecycleFailure && (
                    <p role="alert" className="text-sm text-red-700">{lifecycleFailure}</p>
                  )}                  <button type="button" onClick={requestClose}
                    className="inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500">
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
