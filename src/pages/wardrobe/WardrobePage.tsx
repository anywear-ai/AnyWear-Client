import { useState, useEffect, useMemo } from 'react';
import { useGetWardrobe, useDeleteWardrobeItemsId, useGetWardrobeCategories } from '../../api/endpoints/wardrobe/wardrobe';
import { useGetOutfits } from '../../api/endpoints/outfits/outfits';
import { usePostVtoGenerations } from '../../api/endpoints/vto/vto';
import AddItemModal from './AddItemModal';
import CreateOutfitModal from './CreateOutfitModal';
import ItemDetailsModal from './ItemDetailsModal';
import GenerateLookDialog from './GenerateLookDialog';
import CachedImage from '../../components/CachedImage';
import OutfitLookBadge from '../../components/OutfitLookBadge';
import { getOutfitLookImage } from '../../lib/image-utils';
import { outfitHasActiveGeneration, outfitLookRefetchInterval, type OutfitLookState } from '../../lib/outfit-look';
import { getErrorMessage } from '../../lib/errors';
import { connectSse } from '../../lib/sse';
import { GetWardrobe200Item } from '../../api/model/getWardrobe200Item';
import { GetWardrobeParams } from '../../api/model/getWardrobeParams';
import { GetOutfits200OutfitsItem } from '../../api/model/getOutfits200OutfitsItem';
import { TaggingStatusResponse } from '../../api/model/taggingStatusResponse';
import { useQueryClient } from '@tanstack/react-query';

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

  const queryClient = useQueryClient();

  const { data: wardrobeResponse, isLoading, refetch } = useGetWardrobe(filters, {
    query: {
      refetchInterval: (query) => {
        const items = query.state.data as GetWardrobe200Item[] | undefined;
        return items?.some((item) => (
          item.taggingStatus === 'processing' || item.taggingStatus === 'uploading'
        )) ? 10_000 : false;
      },
    },
  });

  const { data: categoriesResponse } = useGetWardrobeCategories();
  const { mutate: deleteItem } = useDeleteWardrobeItemsId();
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

  const wardrobeData = useMemo<GetWardrobe200Item[]>(
    () => (Array.isArray(wardrobeResponse) ? wardrobeResponse : []),
    [wardrobeResponse],
  );
  const categories = categoriesResponse?.categories ?? [];

  useEffect(() => {
    if (!wardrobeData || !Array.isArray(wardrobeData)) return;

    const connections: Array<ReturnType<typeof connectSse>> = [];

    for (const item of wardrobeData as GetWardrobe200Item[]) {
      if (item.taggingStatus === 'processing' || item.taggingStatus === 'uploading') {
        // A status frame advances the item only when its version is newer than
        // the state the list already shows; a duplicate or out-of-order frame
        // leaves the cached state alone.
        let lastSeenVersion = item.taggingStateVersion;
        const conn = connectSse<TaggingStatusResponse>(
          `/wardrobe/items/${item.id}/stream`,
          (data) => {
            if (data.state_version <= lastSeenVersion) return;
            lastSeenVersion = data.state_version;
            queryClient.invalidateQueries({ queryKey: ['/wardrobe'] });
          },
          {
            eventName: 'status',
            isTerminal: (data) => data.tagging_status === 'ready' || data.tagging_status === 'failed',
          },
        );
        connections.push(conn);
      }
    }

    return () => {
      connections.forEach((c) => c.close());
    };
  }, [wardrobeData, queryClient]);

  const handleDelete = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (window.confirm('Are you sure you want to delete this item?')) {
      deleteItem({ id }, {
        onSuccess: () => {
          if (selectedItem?.id === id) setSelectedItem(null);
          refetch();
        },
      });
    }
  };

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
            const isProcessing = item.taggingStatus === 'processing' || item.taggingStatus === 'uploading';
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
                  onClick={(e) => item.id && handleDelete(item.id, e)}
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
              const lookImage = getOutfitLookImage(outfit.look);
              const latestStatus = outfit.latestGeneration?.status ?? null;
              const isGenerating = outfitHasActiveGeneration(outfit);
              const actionLabel = latestStatus === 'Failed'
                ? 'Retry'
                : lookImage ? 'New look' : 'Generate look';
              return (
                <article
                  key={outfit.id}
                  className="overflow-hidden rounded-xl border border-gray-200 bg-white transition-shadow hover:shadow-md"
                >
                  <button type="button" onClick={() => handleOutfitClick(outfit)} aria-label={`Edit ${outfit.name || 'outfit'}`} className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-600">
                    <div className="aspect-[4/5] bg-gray-100">
                      {lookImage ? (
                        <CachedImage
                          src={lookImage.src}
                          cacheKey={lookImage.cacheKey}
                          alt={outfit.name || 'Outfit'}
                          data-testid={`outfit-thumbnail-${outfit.id}`}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full flex-col items-center justify-center gap-1 px-2 text-center text-sm text-gray-400">
                          <span>{isGenerating ? 'Generating look...' : 'No look yet'}</span>
                        </div>
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
                      <span className="text-xs text-gray-500">Generating...</span>
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
          // the page's existing poll and status stream, and the live list lets each
          // created row show that item's tagging status without a new endpoint.
          items={wardrobeData}
          onItemsCreated={() => {
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
          outfit={selectedOutfit ?? undefined}
        />
      )}

      {selectedItem && (
        <ItemDetailsModal
          item={selectedItem}
          isOpen={!!selectedItem}
          onClose={() => setSelectedItem(null)}
          onSuccess={() => {
            setSelectedItem(null);
            refetch();
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
