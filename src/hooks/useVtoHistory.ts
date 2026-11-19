import { useState, useCallback, useMemo } from 'react';
import { useGetVtoGenerations, useDeleteVtoGenerationsGenerationId } from '../api/endpoints/vto/vto';
import type { GetVtoGenerationsParams } from '../api/model/getVtoGenerationsParams';
import { keepPreviousData } from '@tanstack/react-query';
import { applySettledVtoStatus } from '../lib/vtoHistoryStatus';
import type { VtoSettledStatus } from '../lib/vtoHistoryStatus';
import { retainedKeyCountFromGenerationDelete } from '../lib/vtoGenerationDeleteFailure';
import useVtoRating from './useVtoRating';

const DEFAULT_LIMIT = 12;

/**
 * The History read and the actions over it.
 *
 * `settledStatus` is the terminal status the page already holds for the
 * generation Step 4 is showing, if any. The fetched page stays in the query
 * cache; the rows returned here are derived at render from that page and the
 * status, so a page fetched before the settle cannot show the row as running.
 */
export default function useVtoHistory(settledStatus: VtoSettledStatus | null = null) {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<GetVtoGenerationsParams>({ limit: DEFAULT_LIMIT });
  // The retained-key count of the last delete that committed its rows and
  // still owed object deletion, or null when no incomplete delete is being
  // reported. It is one number for the list, not per row: the row it describes
  // has already left the list.
  const [deleteRetainedKeyCount, setDeleteRetainedKeyCount] = useState<number | null>(null);

  const params: GetVtoGenerationsParams = {
    ...filters,
    page,
    limit: DEFAULT_LIMIT,
  };

  const { data, isLoading, refetch } = useGetVtoGenerations(params, {
    query: { placeholderData: keepPreviousData },
  });

  const { save: saveRating, failures: ratingFailures, echoResetTokens: ratingEchoResetTokens } = useVtoRating();
  const deleteMutation = useDeleteVtoGenerationsGenerationId();

  // The page is the source for every row field except the three the terminal
  // status signs; deriving before paint is what keeps a late page from
  // restoring a `Pending` badge the page no longer holds.
  const generations = useMemo(
    () => applySettledVtoStatus(data ?? null, settledStatus)?.generations ?? [],
    [data, settledStatus],
  );
  const total = data?.total ?? 0;
  const nextPage = data?.nextPage ?? null;

  const goToPage = useCallback((newPage: number) => {
    setPage(newPage);
  }, []);

  // The rating hook invalidates the list, which refetches it; the previous
  // `onSuccess: refetch` would have read the same list twice.
  const rateGeneration = useCallback((generationId: string, rating: number) => {
    saveRating(generationId, rating);
  }, [saveRating]);

  const deleteGeneration = useCallback((generationId: string) => {
    // A new attempt supersedes the previous report, so a later delete can never
    // show a count that belonged to an earlier one.
    setDeleteRetainedKeyCount(null);
    deleteMutation.mutate(
      { generationId },
      {
        onSuccess: () => {
          refetch();
        },
        onError: (error: unknown) => {
          const retainedKeyCount = retainedKeyCountFromGenerationDelete(error);
          // Only the incomplete delete is a state the list has to show. Its
          // rows are committed as deleted, so the cached row is stale and the
          // list is re-read; the objects are owed by the worker's manifest and
          // the count says how many. Every other rejection keeps the previous
          // behaviour: nothing is shown and nothing is re-read.
          if (retainedKeyCount === null) return;
          refetch();
          setDeleteRetainedKeyCount(retainedKeyCount);
        },
      }
    );
  }, [deleteMutation, refetch]);

  return {
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
    deleteRetainedKeyCount,
    ratingFailures,
    ratingEchoResetTokens,
  };
}
