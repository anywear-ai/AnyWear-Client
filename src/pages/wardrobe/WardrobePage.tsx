import { useState, useEffect, useCallback, useRef } from 'react';
import { useDeleteWardrobeItemsId, useGetWardrobeCategories } from '../../api/endpoints/wardrobe/wardrobe';
import { useGetOutfits } from '../../api/endpoints/outfits/outfits';
import { usePostVtoGenerations } from '../../api/endpoints/vto/vto';
import AddItemModal from './AddItemModal';
import CreateOutfitModal from './CreateOutfitModal';
import ItemDetailsModal from './ItemDetailsModal';
import GenerateLookDialog from './GenerateLookDialog';
import DeleteItemDialog from './DeleteItemDialog';
import CachedImage from '../../components/CachedImage';
import OutfitLookBadge from '../../components/OutfitLookBadge';
import { getOutfitLookImage } from '../../lib/image-utils';
import { outfitHasActiveGeneration, outfitLookRefetchInterval, type OutfitLookState } from '../../lib/outfit-look';
import { getErrorMessage } from '../../lib/errors';
import { describeWardrobeItemDeleteFailure, ITEM_ALREADY_GONE_MESSAGE } from '../../lib/wardrobeItemDeleteFailure';
import { connectSse } from '../../lib/sse';
import { mergeWardrobeStatus } from '../../lib/status-arbitration';
import { useWardrobeList } from '../../hooks/useWardrobeList';
import { isClientVersionRefused } from '../../store/clientVersionRefusalStore';
import { GetWardrobe200Item } from '../../api/model/getWardrobe200Item';
import { GetWardrobeParams } from '../../api/model/getWardrobeParams';
import { GetOutfits200OutfitsItem } from '../../api/model/getOutfits200OutfitsItem';
import { TaggingStatusResponse } from '../../api/model/taggingStatusResponse';
import { useQueryClient } from '@tanstack/react-query';

/** Whether the item still has a tagging task the aggregate stream can advance. */
function isInFlightItem(item: GetWardrobe200Item): boolean {
  return item.taggingStatus === 'processing' || item.taggingStatus === 'uploading';
}

/** Whether a tagging lifecycle ended; a newer `processing` is a new one (a re-tag). */
function isTerminalTaggingStatus(status: string): boolean {
  return status === 'ready' || status === 'failed';
}

function getTagStatusBadge(status: string | undefined) {
  switch (status) {
    case 'processing':
      return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">Analyzing...</span>;
    case 'ready':
      return null;
    case 'failed':
      return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">Failed</span>;
    case 'uploading':
      return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">Uploading...</span>;
    default:
      return null;
  }
}

function getColorFromAttributes(styleAttributes: unknown): string | null {
  if (!styleAttributes || typeof styleAttributes !== 'object') return null;
  const sa = styleAttributes as Record<string, unknown>;
  return typeof sa.color === 'string' ? sa.color : null;
}

function getMaterialFromAttributes(styleAttributes: unknown): string | null {
  if (!styleAttributes || typeof styleAttributes !== 'object') return null;
  const sa = styleAttributes as Record<string, unknown>;
  return typeof sa.material === 'string' ? sa.material : null;
}

type OutfitCoverState = 'look' | 'generating' | 'failed' | 'image-unavailable' | 'empty';

/** The cover copy of the states that have no image to paint. */
const COVER_PLACEHOLDER: Record<Exclude<OutfitCoverState, 'look' | 'generating'>, string> = {
  failed: 'Last try-on failed',
  'image-unavailable': 'Image unavailable',
  empty: 'No look yet',
};

/**
 * The cover the card paints, in precedence order: a completed look with a
 * signed URL, then a running generation (which outranks the failed and empty
 * states), then a failed last generation, then a completed look whose URL the
 * Service could not sign, and finally no generation at all.
 */
function outfitCoverState(outfit: GetOutfits200OutfitsItem): OutfitCoverState {
  if (getOutfitLookImage(outfit.look)) return 'look';
  if (outfitHasActiveGeneration(outfit)) return 'generating';
  if (outfit.latestGeneration?.status === 'Failed') return 'failed';
  if (outfit.look) return 'image-unavailable';
  return 'empty';
}

/** The placeholder sentence a cover state paints, or null when it paints an image or skeleton. */
function coverPlaceholder(state: OutfitCoverState): string | null {
  return state === 'look' || state === 'generating' ? null : COVER_PLACEHOLDER[state];
}

/** The action the card offers; a running generation offers none. */
function outfitActionLabel(outfit: GetOutfits200OutfitsItem): string {
  // A failed latest generation offers Retry even while an older completed look
  // is still painted; otherwise a completed look (signed or not) offers New look.
  if (outfit.latestGeneration?.status === 'Failed') return 'Retry';
  if (outfit.look) return 'New look';
  return 'Generate look';
}

/** The page-level notice a delete that still owes image cleanup leaves behind. */
function cleanupNoticeText(retainedObjectKeys: number): string {
  return `Outfit deleted. ${retainedObjectKeys} image${retainedObjectKeys === 1 ? ' is' : 's are'} still being cleaned up in the background.`;
}

/** The message a started re-tag leaves in the page notice after its dialog closes. */
const RETAG_STARTED_TEXT = 'Re-tagging started. Check back shortly.';

/**
 * Everything the page states in its one `role="status"` notice: an outfit delete
 * that still owes image cleanup, a re-tag that outlives the dialog that started
 * it, and a delete whose row was already gone.
 */
type PageNotice =
  | { kind: 'outfit-cleanup'; retainedObjectKeys: number }
  | { kind: 'retag-started' }
  | { kind: 'item-already-gone' };

function noticeText(notice: PageNotice): string {
  switch (notice.kind) {
    case 'outfit-cleanup':
      return cleanupNoticeText(notice.retainedObjectKeys);
    case 'retag-started':
      return RETAG_STARTED_TEXT;
    case 'item-already-gone':
      return ITEM_ALREADY_GONE_MESSAGE;
  }
}

/** The item a grid card asked about, held from the click until the delete settles. */
interface DeleteTarget {
  id: string;
  name?: string | null;
  category?: string | null;
}

export default function WardrobePage() {
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isOutfitModalOpen, setIsOutfitModalOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<GetWardrobe200Item | null>(null);
  const [selectedOutfit, setSelectedOutfit] = useState<GetOutfits200OutfitsItem | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [filters, setFilters] = useState<GetWardrobeParams>({});
  const [lookTarget, setLookTarget] = useState<{ id: string; name?: string | null } | null>(null);
  const [lookError, setLookError] = useState<string | null>(null);
  // Held from the confirm click until the request and its refreshes settle, so
  // the confirmation cannot start a second charge while the first one starts.
  const [isStartingLook, setIsStartingLook] = useState(false);
  // The grid card's whole delete path: the item the panel asks about, the
  // sentence a refused delete leaves beside its control, and where focus lands
  // once the panel has closed.
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleteFailure, setDeleteFailure] = useState<string | null>(null);
  // Set by a delete that took the card with it; the effect below moves focus to
  // the grid region once the panel has actually left the document.
  const restoreFocusToList = useRef(false);
  // The page's one notice, outside every dialog: an outfit whose rows are gone
  // while the Service still owes stored-image cleanup, a re-tag that outlives
  // the dialog that started it, and a row that was already gone.
  const [notice, setNotice] = useState<PageNotice | null>(null);

  const listRegionRef = useRef<HTMLDivElement>(null);

  const queryClient = useQueryClient();

  // One merged list read on mount and on each recovery trigger; no interval.
  const {
    items: wardrobeData,
    isLoading,
    refetch,
    notifyStreamState,
  } = useWardrobeList(filters);

  const { data: categoriesResponse } = useGetWardrobeCategories();
  // The delete is awaited in the panel's handler: the outcome has to be known to
  // decide whether the card leaves and where the sentence goes.
  const { mutateAsync: deleteItem, isPending: isDeleting } = useDeleteWardrobeItemsId();
  const { data: outfitsResponse } = useGetOutfits({
    query: {
      // Poll only while an outfit has a Pending or Processing generation; the
      // terminal statuses (and a page with no generations) return false.
      refetchInterval: (query) => outfitLookRefetchInterval(
        query.state.data as { outfits?: OutfitLookState[] } | undefined,
      ),
    },
  });
  const { mutateAsync: generateLook, isPending: isGeneratingLook } = usePostVtoGenerations();

  const categories = categoriesResponse?.categories ?? [];

  /**
   * The terminal frame emits at the same version that wrote the generated name
   * and category, so it schedules one merged list read. The read runs through
   * `useWardrobeList`'s loop: it coalesces with an in-flight read and gets the
   * trailing read rather than one request per frame. This map is the per-item
   * guard: a replayed or out-of-order terminal frame at a version already
   * handled schedules nothing, while a newer terminal version (a re-tag that
   * finished) may schedule one.
   */
  const lastTerminalReadVersion = useRef(new Map<string, number>());

  /**
   * The aggregate stream's cache-write boundary: one frame advances one item in
   * every cached list that already holds it, and only when its version is newer.
   * A filtered list is never given an item it does not contain. A non-terminal
   * frame merges in place; a terminal frame additionally schedules the one list
   * read that brings the fields the frame does not carry.
   */
  const applyStatusFrame = useCallback((frame: TaggingStatusResponse) => {
    let advanced = false;

    queryClient.setQueriesData<GetWardrobe200Item[]>({ queryKey: ['/wardrobe'] }, (cached) => {
      if (!Array.isArray(cached)) return cached;
      let changed = false;
      const next = cached.map((item) => {
        if (item.id !== frame.item_id) return item;
        // A frame at (or below) the cached version cannot be the transition that
        // wrote a newer name: the item already held that version.
        if (frame.state_version > item.taggingStateVersion) advanced = true;
        const merged = mergeWardrobeStatus(item, frame);
        if (merged !== item) changed = true;
        return merged;
      });
      return changed ? next : cached;
    });

    if (!advanced || !isTerminalTaggingStatus(frame.tagging_status)) return;
    const scheduled = lastTerminalReadVersion.current.get(frame.item_id);
    if (scheduled !== undefined && frame.state_version <= scheduled) return;
    lastTerminalReadVersion.current.set(frame.item_id, frame.state_version);
    void refetch();
  }, [queryClient, refetch]);

  const hasInFlightItem = wardrobeData.some(isInFlightItem);

  useEffect(() => {
    if (!hasInFlightItem) return;

    // One caller-scoped stream per open tab, independent of the batch size. It
    // stays open across a terminal frame and closes only when nothing is in
    // flight; a reconnect reports `open` again, which re-reads the list once.
    const connection = connectSse<TaggingStatusResponse>(
      '/wardrobe/status/stream',
      applyStatusFrame,
      {
        eventName: 'status',
        onStateChange: notifyStreamState,
      },
    );

    return () => {
      connection.close();
    };
  }, [hasInFlightItem, applyStatusFrame, notifyStreamState]);

  /**
   * Every cached wardrobe list drops the row in the same commit as the panel
   * closing, so the card leaves before the refresh lands. A filtered list is
   * trimmed the same way; the categories response is not a list and is left as
   * it is.
   */
  const removeItemFromLists = useCallback((id: string) => {
    queryClient.setQueriesData<GetWardrobe200Item[]>({ queryKey: ['/wardrobe'] }, (cached) => {
      if (!Array.isArray(cached)) return cached;
      const next = cached.filter((item) => item.id !== id);
      return next.length === cached.length ? cached : next;
    });
  }, [queryClient]);

  /**
   * Closes the panel after a delete that took the row with it and asks the focus
   * effect to move focus to the grid region, because the card that opened the
   * confirmation is gone.
   */
  const settleDeletedItem = (id: string, nextNotice?: PageNotice) => {
    if (selectedItem?.id === id) setSelectedItem(null);
    restoreFocusToList.current = true;
    setDeleteTarget(null);
    setDeleteFailure(null);
    if (nextNotice) setNotice(nextNotice);
  };

  const openDeleteConfirmation = (item: GetWardrobe200Item, event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    // The opener is the panel's focus-return target after a decline, so it is
    // focused here rather than left to the engine's click-focus behaviour, which
    // differs between the shells.
    event.currentTarget.focus();
    setDeleteFailure(null);
    setDeleteTarget({ id: item.id, name: item.name, category: item.category });
  };

  const cancelDeleteConfirmation = () => {
    setDeleteTarget(null);
    setDeleteFailure(null);
  };

  const confirmDeleteItem = async () => {
    if (!deleteTarget || isDeleting) return;
    const { id } = deleteTarget;
    setDeleteFailure(null);

    try {
      await deleteItem({ id });
    } catch (error) {
      console.error('Failed to delete item:', error);
      // The terminal refusal owns the whole screen; nothing is written over it.
      if (isClientVersionRefused()) return;
      const failure = describeWardrobeItemDeleteFailure(error);
      if (!failure.gone) {
        // The item stays and its own sentence sits beside the control that sent
        // the request, so the person can retry or cancel.
        setDeleteFailure(failure.message);
        void refetch();
        return;
      }
      // A 404 means the row is already gone: it is a removal, not a failure.
      removeItemFromLists(id);
      settleDeletedItem(id, { kind: 'item-already-gone' });
      void refetch();
      return;
    }

    removeItemFromLists(id);
    settleDeletedItem(id);
    void refetch();
  };

  // A confirmed delete takes the card that opened the confirmation with it — and
  // the details dialog when that surface asked — so focus moves to the grid
  // region that now holds the remaining cards instead of falling back to the
  // body. The flag is a ref because it records only that one of those surfaces
  // closed under a settled delete; it is not rendered state.
  useEffect(() => {
    if (!restoreFocusToList.current) return;
    restoreFocusToList.current = false;
    listRegionRef.current?.focus();
  }, [deleteTarget, selectedItem]);

  const handleCategoryFilter = (category: string) => {
    if (category === 'all') {
      setActiveCategory('all');
      setFilters({});
    } else {
      setActiveCategory(category);
      setFilters({ category });
    }
  };

  const handleRefresh = () => {
    setIsAddModalOpen(false);
    refetch();
  };

  const outfits = outfitsResponse?.outfits ?? [];

  const handleOutfitClick = (outfit: GetOutfits200OutfitsItem) => {
    setSelectedOutfit(outfit);
    setIsOutfitModalOpen(true);
  };

  const handleOutfitModalClose = () => {
    setIsOutfitModalOpen(false);
    setSelectedOutfit(null);
  };

  const openGenerateLook = (outfit: { id: string; name?: string | null }) => {
    setLookError(null);
    setLookTarget({ id: outfit.id, name: outfit.name ?? null });
  };

  const cancelGenerateLook = () => {
    // Cancelling starts nothing and spends nothing; the request is only made by
    // the confirm handler below.
    setLookTarget(null);
    setLookError(null);
  };

  const confirmGenerateLook = async () => {
    if (!lookTarget || isStartingLook) return;
    setIsStartingLook(true);
    setLookError(null);
    try {
      // The card omits base_photo_id: the Service resolves the caller's pointer,
      // then the shared system default.
      await generateLook({ data: { outfit_id: lookTarget.id } });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['/outfits'] as const }),
        queryClient.invalidateQueries({ queryKey: ['/users/me'] as const }),
      ]);
      setLookTarget(null);
    } catch (error) {
      // A drained balance arrives as the Service's 429 body, so its message is
      // shown unchanged; any other failure keeps the dialog open with its cause.
      setLookError(getErrorMessage(error, 'Failed to start the look generation'));
    } finally {
      setIsStartingLook(false);
    }
  };

  return (
    <div>
      <div className="flex justify-between items-center gap-4 mb-6">
        <div>
          <p className="text-sm font-medium text-indigo-700">Your collection</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-gray-900">Wardrobe</h1>
        </div>
        <button
          onClick={() => setIsAddModalOpen(true)}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-lg shadow-sm text-white bg-indigo-600 hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-500"
        >
          Add Item
        </button>
      </div>

      {categories.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2" role="group" aria-label="Filter wardrobe by category">
          <button
            onClick={() => handleCategoryFilter('all')}
            className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
              activeCategory === 'all'
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2`}
            aria-pressed={activeCategory === 'all'}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => handleCategoryFilter(cat)}
              className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
                activeCategory === cat
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2`}
              aria-pressed={activeCategory === cat}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

      {/* The focus target a confirmed delete moves to: the region that holds
          whatever cards remain, including the empty state. It is programmatically
          focusable only, so it adds no tab stop. */}
      <div ref={listRegionRef} tabIndex={-1} aria-label="Wardrobe items" role="region" className="focus:outline-none">
        {isLoading ? (
          <div className="text-center py-12">Loading...</div>
        ) : wardrobeData.length === 0 ? (
          <div className="text-center py-16 px-6 bg-white border border-gray-200 rounded-xl">
            <p className="text-gray-600">Your wardrobe is empty. Tap "Add Item" to get started.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 sm:gap-4">
            {(wardrobeData as GetWardrobe200Item[]).map((item) => {
              const color = getColorFromAttributes(item.styleAttributes);
              const material = getMaterialFromAttributes(item.styleAttributes);
              const statusBadge = getTagStatusBadge(item.taggingStatus);
              const isProcessing = isInFlightItem(item);
              const primaryImage = item.images.find((image) => image.isPrimary) ?? item.images[0];

              return (
                <article
                  key={item.id}
                  className="relative group overflow-hidden rounded-xl border border-gray-200 bg-white transition-shadow hover:shadow-md"
                >
                  <button
                    type="button"
                    disabled={isProcessing}
                    aria-label={`View ${item.name || item.category || 'wardrobe item'} details`}
                    onClick={() => setSelectedItem(item)}
                    className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-600 disabled:cursor-default"
                  >
                    <div className="aspect-[4/5] bg-gray-100">
                      {primaryImage?.url ? (
                        <CachedImage
                          src={primaryImage.url}
                          cacheKey={primaryImage.imageId}
                          alt={item.category || 'Wardrobe item'}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-sm text-gray-400">No Image</div>
                      )}
                    </div>
                    <div className="min-h-20 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="min-w-0 truncate text-sm font-medium text-gray-900">{item.name || item.category || 'Unknown'}</h3>
                        {statusBadge}
                      </div>
                      {(color || material) && <p className="mt-1 text-xs text-gray-500">{[color, material].filter(Boolean).join(' • ')}</p>}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => openDeleteConfirmation(item, e)}
                    aria-label={`Delete ${item.name || item.category || 'wardrobe item'}`}
                    className="absolute right-2 top-2 rounded-full bg-white/95 p-2 text-red-700 shadow-sm opacity-100 transition-opacity hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {notice && (
        <div
          role="status"
          className="mt-8 flex items-center justify-between gap-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3"
        >
          <p className="text-sm text-green-800">{noticeText(notice)}</p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="rounded-lg px-2 py-1 text-sm font-medium text-green-800 hover:bg-green-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            Dismiss
          </button>
        </div>
      )}

      {outfits.length > 0 && (
        <div className="mt-8">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold tracking-tight text-gray-900">My Outfits</h2>
            <button
              onClick={() => {
                setSelectedOutfit(null);
                setIsOutfitModalOpen(true);
              }}
              className="inline-flex items-center px-3 py-1.5 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700"
            >
              + Create Outfit
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 sm:gap-4">
            {outfits.map((outfit) => {
              const coverState = outfitCoverState(outfit);
              const placeholder = coverPlaceholder(coverState);
              const lookImage = getOutfitLookImage(outfit.look);
              const latestStatus = outfit.latestGeneration?.status ?? null;
              const isGenerating = outfitHasActiveGeneration(outfit);
              const actionLabel = outfitActionLabel(outfit);
              return (
                <article
                  key={outfit.id}
                  className="overflow-hidden rounded-xl border border-gray-200 bg-white transition-shadow hover:shadow-md"
                >
                  <button type="button" onClick={() => handleOutfitClick(outfit)} aria-label={`Edit ${outfit.name || 'outfit'}`} className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-600">
                    <div className="aspect-[4/5] bg-gray-100">
                      {coverState === 'look' && lookImage ? (
                        <CachedImage
                          src={lookImage.src}
                          cacheKey={lookImage.cacheKey}
                          alt={outfit.name || 'Outfit'}
                          data-testid={`outfit-thumbnail-${outfit.id}`}
                          className="h-full w-full object-cover"
                        />
                      ) : placeholder ? (
                        <div className="flex h-full flex-col items-center justify-center gap-1 px-2 text-center text-sm text-gray-400">
                          <span>{placeholder}</span>
                        </div>
                      ) : (
                        <div
                          data-testid={`outfit-cover-skeleton-${outfit.id}`}
                          aria-busy="true"
                          className="h-full w-full animate-pulse bg-gray-200"
                        />
                      )}
                    </div>
                    <div className="p-3">
                      <h3 className="truncate text-sm font-medium text-gray-900">{outfit.name || 'Untitled Outfit'}</h3>
                      <p className="mt-1 text-xs text-gray-500">{outfit.wearableItems?.length ?? 0} items</p>
                    </div>
                  </button>
                  {/* Sibling of the edit button: a button cannot be nested inside another. */}
                  <div className="flex items-center justify-between gap-2 border-t border-gray-100 px-3 py-2">
                    <OutfitLookBadge status={latestStatus} />
                    {isGenerating ? (
                      <span className="text-xs text-gray-500">Generating…</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => openGenerateLook(outfit)}
                        aria-label={`${actionLabel} for ${outfit.name || 'outfit'}`}
                        className="rounded-lg bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                      >
                        {actionLabel}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}

      {outfits.length === 0 && (
        <div className="mt-8 bg-white shadow sm:rounded-lg p-6 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-700">No outfits yet</p>
            <p className="text-xs text-gray-500">Group wardrobe items into outfits for quick try-ons.</p>
          </div>
          <button
            onClick={() => {
              setSelectedOutfit(null);
              setIsOutfitModalOpen(true);
            }}
            className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700"
          >
            Create Outfit
          </button>
        </div>
      )}

      {isAddModalOpen && (
        <AddItemModal
          isOpen={isAddModalOpen}
          onClose={() => setIsAddModalOpen(false)}
          onSuccess={handleRefresh}
          // A confirmed photo is an ordinary item: refreshing puts it in front of
          // the page's aggregate status stream, and the live list lets each created
          // row show that item's tagging status without a new endpoint.
          items={wardrobeData}
          onItemsCreated={() => {
            // The Service creates the item with category 'pending', which an active
            // category filter excludes; clearing it keeps the new item in front of
            // the page's status stream so the dialog's row can leave processing.
            // No endpoint, interval or query is added.
            if (activeCategory !== 'all') {
              setActiveCategory('all');
              setFilters({});
            }
            void refetch();
          }}
        />
      )}

      {isOutfitModalOpen && (
        <CreateOutfitModal
          isOpen={isOutfitModalOpen}
          onClose={handleOutfitModalClose}
          onSuccess={() => queryClient.invalidateQueries({ queryKey: ['/outfits'] })}
          onSaved={openGenerateLook}
          onNotice={(cleanup) => setNotice({ kind: 'outfit-cleanup', retainedObjectKeys: cleanup.retainedObjectKeys })}
          outfit={selectedOutfit ?? undefined}
        />
      )}

      <DeleteItemDialog
        isOpen={deleteTarget !== null}
        itemName={deleteTarget?.name}
        itemCategory={deleteTarget?.category}
        isSubmitting={isDeleting}
        failureMessage={deleteFailure}
        onCancel={cancelDeleteConfirmation}
        onConfirm={confirmDeleteItem}
      />

      {selectedItem && (
        <ItemDetailsModal
          item={selectedItem}
          isOpen={!!selectedItem}
          onClose={() => setSelectedItem(null)}
          onSuccess={() => {
            setSelectedItem(null);
            refetch();
          }}
          onDeleted={(outcome) => {
            // The dialog's own delete removed the row: it leaves every cached
            // list here, the dialog closes, and focus moves to what remains.
            removeItemFromLists(selectedItem.id);
            setSelectedItem(null);
            restoreFocusToList.current = true;
            if (outcome === 'already-gone') setNotice({ kind: 'item-already-gone' });
            void refetch();
          }}
          onRetagStarted={() => {
            // The message now outlives the dialog that asked for the re-tag; the
            // card picks up `Analyzing...` from the refreshed list.
            setSelectedItem(null);
            setNotice({ kind: 'retag-started' });
            void refetch();
          }}
        />
      )}

      <GenerateLookDialog
        isOpen={!!lookTarget}
        outfitName={lookTarget?.name ?? null}
        isSubmitting={isGeneratingLook || isStartingLook}
        errorMessage={lookError}
        onCancel={cancelGenerateLook}
        onConfirm={confirmGenerateLook}
      />
    </div>
  );
}
