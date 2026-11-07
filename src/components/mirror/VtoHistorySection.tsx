import { useEffect, useRef, useState } from 'react';
import useVtoHistory from '../../hooks/useVtoHistory';
import useAccessibleDialog from '../../hooks/useAccessibleDialog';
import CachedImage from '../CachedImage';
import RatingWidget from './RatingWidget';
import { getErrorMessage } from '../../lib/errors';
import type { GetVtoGenerationsStatus } from '../../api/model/getVtoGenerationsStatus';
import type { GetVtoGenerations200GenerationsItem } from '../../api/model/getVtoGenerations200GenerationsItem';
import type { PostVtoGenerationsBody } from '../../api/model/postVtoGenerationsBody';

const RETRY_BLOCKED_REASON_ID = 'vto-retry-blocked-reason';
const RETRY_FAILURE_FALLBACK = 'Failed to retry this generation';

/** The only advanced settings the Service accepts; any other stored key fails the POST. */
const ADVANCED_SETTING_KEYS = ['size', 'seed'] as const;

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const diff = now - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hrs < 24) return `${hrs}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

// The Service allowlists `size` and `seed` and rejects any other key before
// charging or enqueuing, so the stored object is copied key by key instead of
// forwarded as-is.
function forwardedAdvancedSettings(
  value: unknown,
): PostVtoGenerationsBody['advanced_settings'] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const stored = value as Record<string, unknown>;
  const forwarded: Record<string, unknown> = {};
  for (const key of ADVANCED_SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(stored, key)) forwarded[key] = stored[key];
  }
  return Object.keys(forwarded).length > 0 ? forwarded : null;
}

/**
 * Rebuilds the POST body from what the failed row recorded.
 *
 * The history record keeps no base photo, so the page's current effective
 * selection supplies `base_photo_id`; it keeps no outfit, so `outfit_id` and
 * `outfit_name` are never sent and the Service snapshots a fresh outfit from
 * the recorded items.
 */
function buildRetryBody(
  generation: GetVtoGenerations200GenerationsItem,
  basePhotoId: string | null,
): PostVtoGenerationsBody {
  const body: PostVtoGenerationsBody = {
    wearable_item_ids: generation.items.map((item) => item.id),
  };
  if (basePhotoId) body.base_photo_id = basePhotoId;
  if (typeof generation.promptUsed === 'string' && generation.promptUsed.length > 0) {
    body.prompt = generation.promptUsed;
  }
  const advancedSettings = forwardedAdvancedSettings(generation.advancedSettings);
  if (advancedSettings) body.advanced_settings = advancedSettings;
  return body;
}

/**
 * The one page-level blocker, in precedence order. While it is set every Retry
 * stays focusable but is `aria-disabled`, and its click is guarded.
 */
function retryBlockedReason(
  isGenerating: boolean,
  basePhotoId: string | null,
  credits: number,
): string | null {
  if (isGenerating) return 'A generation is already running — wait for it to finish.';
  if (basePhotoId === null) return 'Select a base photo in Step 1 to retry.';
  if (credits <= 0) return 'Out of daily credits. Credits reset at midnight.';
  return null;
}

interface VtoHistorySectionProps {
  onReuseOutfit: (wearableItemIds: string[]) => void;
  onRetryGeneration: (body: PostVtoGenerationsBody) => Promise<void>;
  basePhotoId: string | null;
  credits: number;
  isGenerating: boolean;
}

export default function VtoHistorySection({
  onReuseOutfit,
  onRetryGeneration,
  basePhotoId,
  credits,
  isGenerating,
}: VtoHistorySectionProps) {
  const {
    generations,
    total,
    page,
    nextPage,
    goToPage,
    isLoading,
    filters,
    setFilters,
    rateGeneration,
    deleteGeneration,
    ratingFailures,
    ratingEchoResetTokens,
  } = useVtoHistory();
  const [viewImageUrl, setViewImageUrl] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const deleteButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const restoreDeleteFocusId = useRef<string | null>(null);

  // The confirmation replaces the action set, so it owns focus: Cancel on open,
  // and that card's Delete control again when the confirmation closes.
  useEffect(() => {
    if (confirmDeleteId) {
      cancelButtonRef.current?.focus();
      return;
    }
    const restoreId = restoreDeleteFocusId.current;
    restoreDeleteFocusId.current = null;
    if (restoreId) deleteButtonRefs.current.get(restoreId)?.focus();
  }, [confirmDeleteId]);

  const blockedReason = retryBlockedReason(isGenerating, basePhotoId, credits);

  const handleRetry = async (generation: GetVtoGenerations200GenerationsItem) => {
    if (blockedReason || retryingId) return;
    setRetryError(null);
    setRetryingId(generation.id);
    try {
      await onRetryGeneration(buildRetryBody(generation, basePhotoId));
      // The new Pending row is the newest entry: clear the status filter and
      // return to page 1 so it is on screen when the refetch lands.
      setFilters({ ...filters, status: undefined });
      goToPage(1);
    } catch (error) {
      setRetryError(getErrorMessage(error, RETRY_FAILURE_FALLBACK));
    } finally {
      setRetryingId(null);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={filters.status ?? ''}
          onChange={(e) => {
            const val = e.target.value as GetVtoGenerationsStatus | '';
            setFilters({ ...filters, status: val || undefined });
          }}
          className="border border-gray-300 rounded-md px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">All Status</option>
          <option value="Complete">Complete</option>
          <option value="Failed">Failed</option>
          <option value="Pending">Pending</option>
          <option value="Processing">Processing</option>
        </select>
      </div>

      {blockedReason && (
        <p id={RETRY_BLOCKED_REASON_ID} role="status" className="mb-3 text-sm text-gray-600">
          {blockedReason}
        </p>
      )}

      {retryError && (
        <p role="alert" className="mb-3 text-sm text-red-700">
          {retryError}
        </p>
      )}

      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="animate-pulse bg-gray-200 rounded-lg aspect-[3/4]" />
          ))}
        </div>
      ) : generations.length === 0 ? (
        <div className="bg-gray-50 rounded-lg border-2 border-dashed border-gray-300 p-6 text-center">
          <p className="text-sm text-gray-500">No try-on sessions yet. Select your base photo and wearable items above to get started.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {generations.map((gen: GetVtoGenerations200GenerationsItem) => {
              const wearableItemIds = gen.items?.map((item) => item.id) ?? [];
              const imageUrl = gen.url;
              const imageId = gen.imageId;
              return (
                <div key={gen.id} className="relative group bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                  <div data-testid="vto-history-media" className="relative aspect-[3/4] bg-gray-200 overflow-hidden">
                    {imageUrl ? (
                      <CachedImage
                        src={imageUrl}
                        cacheKey={`vto-hist-${imageId}`}
                        alt="Try-on history"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="flex items-center justify-center h-full text-gray-400 text-xs">
                        {gen.status === 'Failed' ? 'Generation failed' : 'No image'}
                      </div>
                    )}
                    {/* The reveal is scoped to this overlay, not the card: a focused
                        rating star outside it must not scrim the star. The overlay
                        is a child of the media wrapper, so its box ends with the
                        image and never covers the card body. */}
                    <div
                      data-testid="vto-history-actions"
                      className={`absolute inset-0 bg-black/50 transition-opacity focus-within:transition-none flex flex-col items-center justify-center gap-2 p-3 ${
                        confirmDeleteId === gen.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
                      }`}
                    >
                      {confirmDeleteId === gen.id ? (
                        <>
                          <p className="text-white text-xs font-medium text-center">Delete this try-on?</p>
                          <button
                            type="button"
                            onClick={() => {
                              restoreDeleteFocusId.current = null;
                              deleteGeneration(gen.id);
                              setConfirmDeleteId(null);
                            }}
                            className="w-full text-xs bg-red-500 text-white px-3 py-1.5 rounded hover:bg-red-600 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                          >
                            Yes, Delete
                          </button>
                          <button
                            type="button"
                            ref={cancelButtonRef}
                            onClick={() => {
                              restoreDeleteFocusId.current = gen.id;
                              setConfirmDeleteId(null);
                            }}
                            className="w-full text-xs bg-white/90 text-gray-800 px-3 py-1.5 rounded hover:bg-white text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          {imageUrl && (
                            <button
                              type="button"
                              onClick={() => setViewImageUrl(imageUrl)}
                              className="w-full text-xs bg-white/90 text-gray-800 px-3 py-1.5 rounded hover:bg-white text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                            >
                              View Full
                            </button>
                          )}
                          {wearableItemIds.length > 0 && (
                            <button
                              type="button"
                              onClick={() => onReuseOutfit(wearableItemIds)}
                              className="w-full text-xs bg-white/90 text-gray-800 px-3 py-1.5 rounded hover:bg-white text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                            >
                              Reuse Outfit
                            </button>
                          )}
                          {gen.status === 'Failed' && gen.items.length > 0 && (
                            <button
                              type="button"
                              onClick={() => handleRetry(gen)}
                              aria-disabled={blockedReason || retryingId === gen.id ? 'true' : undefined}
                              aria-describedby={blockedReason ? RETRY_BLOCKED_REASON_ID : undefined}
                              className={`w-full text-xs bg-white/90 text-gray-800 px-3 py-1.5 rounded hover:bg-white text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 ${
                                blockedReason ? 'opacity-50 cursor-not-allowed' : ''
                              }`}
                            >
                              {retryingId === gen.id ? 'Retrying…' : 'Retry'}
                            </button>
                          )}
                          <button
                            type="button"
                            ref={(node) => {
                              if (node) deleteButtonRefs.current.set(gen.id, node);
                              else deleteButtonRefs.current.delete(gen.id);
                            }}
                            onClick={() => {
                              restoreDeleteFocusId.current = null;
                              setConfirmDeleteId(gen.id);
                            }}
                            className="w-full text-xs bg-red-500/90 text-white px-3 py-1.5 rounded hover:bg-red-500 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="p-2">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-gray-500">{relativeTime(gen.createdAt)}</span>
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium ${
                        gen.status === 'Complete' ? 'bg-green-100 text-green-800' :
                        gen.status === 'Failed' ? 'bg-red-100 text-red-800' :
                        'bg-yellow-100 text-yellow-800'
                      }`}>
                        {gen.status}
                      </span>
                    </div>
                    {gen.items.length > 0 && (
                      <p className="text-xs text-gray-500">{gen.items.length} wearable item{gen.items.length !== 1 ? 's' : ''}</p>
                    )}
                    {gen.rating != null ? (
                      <RatingWidget rating={gen.rating} onChange={() => {}} readonly />
                    ) : gen.status === 'Complete' && (
                      <RatingWidget
                        rating={null}
                        onChange={(r) => rateGeneration(gen.id, r)}
                        echoResetToken={ratingEchoResetTokens[gen.id] ?? 0}
                      />
                    )}
                    {ratingFailures[gen.id] && (
                      <p role="alert" className="mt-1 text-xs text-red-700">
                        {ratingFailures[gen.id]}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex items-center justify-between">
            <span className="text-sm text-gray-500">
              Page {page} of {Math.ceil(total / (filters.limit || 12))}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => goToPage(page - 1)}
                disabled={page <= 1}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              {nextPage && (
                <button
                  onClick={() => goToPage(nextPage)}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  Next
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {viewImageUrl && (
        <VtoImageViewer url={viewImageUrl} onClose={() => setViewImageUrl(null)} />
      )}
    </div>
  );
}

interface VtoImageViewerProps {
  url: string;
  onClose: () => void;
}

/**
 * The full-image viewer as a modal dialog. It exists only while an image is
 * open, so the shared focus hook captures the View Full control that opened it
 * and restores focus there on close.
 */
function VtoImageViewer({ url, onClose }: VtoImageViewerProps) {
  const dialogRef = useAccessibleDialog(onClose);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/80"
        onClick={onClose}
        data-testid="vto-viewer-backdrop"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vto-viewer-title"
        tabIndex={-1}
        className="relative max-w-4xl max-h-[90vh]"
      >
        <h2 id="vto-viewer-title" className="sr-only">Try-on full view</h2>
        <img src={url} alt="Full view" className="max-w-full max-h-[90vh] object-contain rounded-lg" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close full view"
          className="absolute top-2 right-2 bg-white rounded-full p-1 shadow-lg hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
        >
          <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
