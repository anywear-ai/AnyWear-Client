import {
  getWardrobeItemsItemIdDependentOutfits,
  useGetWardrobeItemsItemIdDependentOutfits,
} from '../api/endpoints/wardrobe/wardrobe';
import type { GetWardrobeItemsItemIdDependentOutfits200 } from '../api/model/getWardrobeItemsItemIdDependentOutfits200';
import type { GetWardrobeItemsItemIdDependentOutfits200OutfitsItem } from '../api/model/getWardrobeItemsItemIdDependentOutfits200OutfitsItem';

/**
 * Issue 350 — the complete dependent-outfit preview of one Storage Box delete.
 *
 * `GET /wardrobe/items/{item_id}/dependent-outfits` is paged: it caps `limit` at
 * 100 and answers an exact `total` beside at most one page. The delete
 * confirmation may only enable once it holds every outfit the Service counts, so
 * the whole preview is one server read: this hook overrides the generated hook's
 * `queryFn` with a sequential sweep that walks `offset` until the deduplicated set
 * reaches `total`.
 *
 * The cache entry is keyed by the item alone (`params: undefined`), so one entry
 * means "the complete preview for this item" and never "page k of it". No entry
 * holds a partial list either: `data` is absent until the sweep resolves, which is
 * what keeps a partially composed list away from the confirmation's control.
 */
export const DEPENDENT_OUTFIT_PAGE_LIMIT = 100;

export interface DependentOutfitPreview {
  /**
   * Every dependent outfit the Service counts, or null while the sweep is in
   * flight or after it failed. Never a partial list.
   */
  outfits: GetWardrobeItemsItemIdDependentOutfits200OutfitsItem[] | null;
  /** The Service's exact dependency count, or null while the sweep is unresolved. */
  total: number | null;
  /** Whether a sweep is in flight. */
  isLoading: boolean;
  /** Whether a page failed, or the pages stopped composing one list. */
  isError: boolean;
  /** Re-runs the whole sweep from the first page; the only retry there is. */
  refetch: () => void;
}

/**
 * Read one page. `offset` advances by the page size, not by the rows that arrived,
 * so a short page cannot shift the window of the pages after it.
 */
function readDependentOutfitPage(
  itemId: string,
  pageIndex: number,
  signal: AbortSignal,
): Promise<GetWardrobeItemsItemIdDependentOutfits200> {
  return getWardrobeItemsItemIdDependentOutfits(
    itemId,
    {
      limit: DEPENDENT_OUTFIT_PAGE_LIMIT,
      offset: pageIndex * DEPENDENT_OUTFIT_PAGE_LIMIT,
    },
    undefined,
    signal,
  );
}

/**
 * Page 0, then page 1, and so on, until the deduplicated set holds the exact
 * `total` the first page reported. A stable set costs exactly ⌈total/limit⌉ reads,
 * one read when `total` is 0, and every offset is distinct by construction.
 *
 * It fails closed. A page that adds no outfit while `total` is not yet held, or a
 * page whose `total` differs from the first page's, rejects the read: offsets
 * index a total order on outfit ids, so an outfit created or deleted in another
 * window shifts the pages and the accumulated list can name a removed outfit while
 * omitting a live one. Enabling a delete over such a list would hide an outfit the
 * person is about to lose, so the sweep refuses instead of guessing.
 *
 * The query's `AbortSignal` reaches every page, so an abandoned observer stops the
 * sweep rather than leaving a page read behind it.
 */
async function readEveryDependentOutfit(
  itemId: string,
  signal: AbortSignal,
): Promise<GetWardrobeItemsItemIdDependentOutfits200> {
  const held = new Map<string, GetWardrobeItemsItemIdDependentOutfits200OutfitsItem>();
  let total: number | null = null;

  for (let pageIndex = 0; ; pageIndex += 1) {
    const page = await readDependentOutfitPage(itemId, pageIndex, signal);

    if (total === null) {
      total = page.total;
    } else if (page.total !== total) {
      throw new Error(`The dependent outfit count moved between pages for item ${itemId}.`);
    }

    let added = 0;
    for (const outfit of page.outfits) {
      if (held.has(outfit.id)) continue;
      held.set(outfit.id, outfit);
      added += 1;
    }

    if (held.size === total) return { total, outfits: [...held.values()] };
    if (added === 0) {
      throw new Error(
        `A dependent outfit page added nothing before item ${itemId} reached its total.`,
      );
    }
  }
}

/**
 * The Storage Box confirmation's one preview read.
 *
 * `itemId` is the item the open panel asks about; an absent id disables the read,
 * so the closed panel issues nothing. Opening the panel enables it and issues a
 * fresh sweep, which is what clears a try-on that settled while the panel was
 * closed.
 */
export function useDependentOutfitPreview(itemId: string | null | undefined): DependentOutfitPreview {
  const id = itemId ?? '';

  const preview = useGetWardrobeItemsItemIdDependentOutfits(id, undefined, {
    query: {
      enabled: !!id,
      // A half-read list is the person's to retry: `Try again` in the confirmation
      // is the only retry, so the query policy never re-runs the sweep behind them.
      retry: false,
      // The preview is always re-read when the panel opens again: nothing else
      // observes it, and a stale list would answer for a set that has moved on.
      staleTime: 0,
      queryFn: ({ signal }) => readEveryDependentOutfit(id, signal),
    },
  });

  const data = preview.data ?? null;

  return {
    outfits: data?.outfits ?? null,
    total: data?.total ?? null,
    isLoading: preview.isFetching,
    isError: preview.isError,
    refetch: () => {
      void preview.refetch();
    },
  };
}
