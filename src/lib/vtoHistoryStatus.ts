import type { GetVtoGenerations200 } from '../api/model/getVtoGenerations200';
import type { VtoStatusResponseStatus } from '../api/model/vtoStatusResponseStatus';

/**
 * The members of a generation's terminal status that a History row carries.
 *
 * The status response carries no `createdAt`, `items` or `rating`, so it can
 * correct only the three fields both reads sign; the page's row supplies the
 * rest.
 */
export interface VtoSettledStatus {
  generation_id: string;
  status: VtoStatusResponseStatus;
  imageId: string | null;
  url: string | null;
}

/**
 * Derive the History rows from a fetched page and the terminal status the page
 * already holds.
 *
 * The terminal frame reaches Step 4 and the History card through two different
 * reads that settle in either order, so the page is not trusted for that
 * generation's row: `status`, `imageId` and `url` come from the status. The row
 * keeps its index and every other field — `createdAt`, `items`, `rating`,
 * `promptUsed` and `advancedSettings` — and no row is inserted or removed, so a
 * page that lands after the settle cannot move or add a card. When the input is
 * not a page, no row matches, or the row already carries those three values,
 * the page reference is returned unchanged, which keeps the caller's memo
 * stable across renders.
 */
export function applySettledVtoStatus(
  page: GetVtoGenerations200 | null | undefined,
  settled: VtoSettledStatus | null | undefined,
): GetVtoGenerations200 | null | undefined {
  if (!page || !Array.isArray(page.generations) || !settled) return page;

  const index = page.generations.findIndex((row) => row.id === settled.generation_id);
  if (index === -1) return page;

  const row = page.generations[index];
  if (
    row.status === settled.status
    && row.imageId === settled.imageId
    && row.url === settled.url
  ) {
    return page;
  }

  const generations = page.generations.slice();
  generations[index] = {
    ...row,
    status: settled.status,
    imageId: settled.imageId,
    url: settled.url,
  };

  return { ...page, generations };
}
