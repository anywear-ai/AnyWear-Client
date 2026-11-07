import { useState, useCallback } from 'react';
import { useGetVtoGenerations, useDeleteVtoGenerationsGenerationId } from '../api/endpoints/vto/vto';
import type { GetVtoGenerationsParams } from '../api/model/getVtoGenerationsParams';
import { keepPreviousData } from '@tanstack/react-query';
import useVtoRating from './useVtoRating';

const DEFAULT_LIMIT = 12;

export default function useVtoHistory() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<GetVtoGenerationsParams>({ limit: DEFAULT_LIMIT });

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

  const generations = data?.generations ?? [];
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
    deleteMutation.mutate(
      { generationId },
      {
        onSuccess: () => {
          refetch();
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
    ratingFailures,
    ratingEchoResetTokens,
  };
}
