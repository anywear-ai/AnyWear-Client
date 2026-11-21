import CachedImage from '../CachedImage';
import { getOutfitLookImage } from '../../lib/image-utils';
import type { GetOutfitsLookup200Outfit } from '../../api/model/getOutfitsLookup200Outfit';

interface OutfitLookupNoticeProps {
  /** The outfit the Service matched for the selected items, or null for no match. */
  outfit: GetOutfitsLookup200Outfit | null;
  /** True while the lookup is still running; the notice states nothing until it answers. */
  isLoading: boolean;
}

/**
 * Issue 335 — the selected set already has an outfit.
 *
 * `GET /outfits/lookup` is read-only and charges nothing, so this notice can show
 * what the user already owns *before* the Try-on button spends a credit: the
 * outfit's name, its latest completed look and how many try-on records it already
 * has. Pressing Try-on then appends a record to this outfit instead of creating a
 * second card for the same combination.
 *
 * It renders nothing on a miss and nothing while the lookup is running, so the
 * page never flashes a stale match over a newer selection.
 */
export default function OutfitLookupNotice({ outfit, isLoading }: OutfitLookupNoticeProps) {
  if (isLoading || !outfit) return null;

  const lookImage = getOutfitLookImage(outfit.look);
  const recordCount = outfit.generationCount ?? 0;
  const records = recordCount === 1 ? '1 try-on record' : `${recordCount} try-on records`;
  const name = outfit.name || 'This outfit';

  return (
    <div
      data-testid="outfit-lookup-hit"
      role="status"
      className="rounded-lg border border-indigo-200 bg-white/70 p-3"
    >
      <div className="flex items-center gap-3">
        {lookImage ? (
          <CachedImage
            src={lookImage.src}
            cacheKey={lookImage.cacheKey}
            alt={`Latest look for ${name}`}
            className="h-12 w-12 flex-shrink-0 rounded-lg object-cover"
          />
        ) : (
          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg bg-gray-100 text-[10px] text-gray-400">
            No look
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-gray-900">{name}</p>
          <p className="text-xs text-gray-600">
            Saved outfit · {records}
          </p>
        </div>
      </div>
      <p className="mt-2 text-xs text-gray-600">
        These items already make up a saved outfit. Generating adds another record to it — no new
        outfit is created, and no credit is spent until you press Try on.
      </p>
    </div>
  );
}
