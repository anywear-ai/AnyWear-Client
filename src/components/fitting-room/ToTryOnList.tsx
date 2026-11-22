import CachedImage from '../CachedImage';
import { getPrimaryImageUrl } from '../../lib/image-utils';
import type { GetFittingRoomsFittingRoomId200ItemsItem } from '../../api/model/getFittingRoomsFittingRoomId200ItemsItem';

/**
 * The number of pieces one try-on accepts. The staging area itself has no cap:
 * a room keeps every candidate, and only the ticked subset is bounded, which is
 * why the counter reads `N / 5` over the selection rather than the list.
 */
export const MAX_TICKED_ITEMS = 5;

interface ToTryOnListProps {
  /** Every staged member of the open room, archived ones included. */
  items: GetFittingRoomsFittingRoomId200ItemsItem[];
  /** The ticked subset — client view state, never persisted. */
  selectedIds: string[];
  onToggle: (itemId: string) => void;
  onRemove: (itemId: string) => void;
  isRemoving?: boolean;
}

function itemLabel(item: GetFittingRoomsFittingRoomId200ItemsItem): string {
  return item.name || item.category || 'wardrobe item';
}

/**
 * Issue 313 — the room's `To try on` area. Issue 351 made each row's tile the
 * control, using the base-photo picker's own convention.
 *
 * Staged rows are the room's own members: they survive a compose attempt, they
 * keep an archived piece visible with its badge instead of silently shrinking the
 * list, and each one can be unticked or removed. The counter names the selection
 * bound, so a sixth tick is explained before it is refused.
 *
 * The tiles form a toggle button group, never `role="radio"`: up to five of an
 * unlimited staged set can be pressed at once. `Remove` is a separate sibling
 * button, so taking a piece out of the room stays distinguishable from
 * un-choosing it for this try-on, and an archived piece keeps its badge, gets a
 * disabled tile and keeps `Remove` enabled.
 */
export default function ToTryOnList({
  items,
  selectedIds,
  onToggle,
  onRemove,
  isRemoving = false,
}: ToTryOnListProps) {
  const counter = `${Math.min(selectedIds.length, MAX_TICKED_ITEMS)} / ${MAX_TICKED_ITEMS}`;

  if (items.length === 0) {
    return (
      <div className="rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 p-6 text-center">
        <p className="text-sm text-gray-500">
          Nothing is staged yet. Click pieces in Wardrobe above to keep them here for this room.
        </p>
      </div>
    );
  }

  return (
    <div role="group" aria-label="Staged pieces">
      <p aria-live="polite" className="mb-2 text-xs font-medium text-gray-600">
        {selectedIds.length} of {MAX_TICKED_ITEMS} selected
        <span data-testid="to-try-on-counter" className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 font-semibold text-gray-700">
          {counter}
        </span>
      </p>
      <ul data-testid="to-try-on-list" className="divide-y divide-gray-100 rounded-lg border border-gray-200">
        {items.map((item) => {
          const label = itemLabel(item);
          const isArchived = (item.archivedAt ?? null) !== null;
          const isSelected = selectedIds.includes(item.id);
          const imageUrl = getPrimaryImageUrl(item.images);
          const primaryImageId = item.images.find((image) => image.isPrimary)?.imageId
            ?? item.images[0]?.imageId;
          return (
            <li key={item.id} data-testid="to-try-on-row" className="flex flex-wrap items-center gap-3 p-2.5">
              <button
                type="button"
                onClick={() => onToggle(item.id)}
                disabled={isArchived}
                aria-pressed={isSelected}
                aria-label={`${isSelected ? 'Selected' : 'Select'} ${label}`}
                className={`flex min-w-0 flex-1 items-center gap-3 rounded-lg border p-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 disabled:cursor-not-allowed disabled:opacity-50 ${
                  isSelected
                    ? 'border-indigo-600 ring-1 ring-indigo-600'
                    : 'border-gray-200 hover:border-gray-400'
                }`}
              >
                <span className="block h-12 w-12 flex-shrink-0 overflow-hidden rounded-md bg-gray-100">
                  {imageUrl && primaryImageId ? (
                    <CachedImage
                      src={imageUrl}
                      cacheKey={primaryImageId}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="flex h-full items-center justify-center text-[10px] text-gray-400">No Image</span>
                  )}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-gray-900">{label}</span>
                    {isArchived && (
                      <span
                        data-testid="to-try-on-archived"
                        className="inline-flex flex-shrink-0 items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
                      >
                        Archived
                      </span>
                    )}
                    {isSelected && (
                      <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white">
                        <svg
                          aria-hidden="true"
                          className="h-3 w-3"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={3}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M5 13l4 4L19 7" />
                        </svg>
                        Selected
                      </span>
                    )}
                  </span>
                  {isArchived && (
                    <span className="mt-0.5 block text-xs text-gray-600">
                      Restore this piece in the Storage Box to try it on again.
                    </span>
                  )}
                </span>
              </button>

              <button
                type="button"
                onClick={() => onRemove(item.id)}
                disabled={isRemoving}
                aria-label={`Remove ${label} from try on`}
                className="rounded-md bg-white px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
