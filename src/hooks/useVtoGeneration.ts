import { useState, useCallback, useEffect, useRef } from 'react';
import {
  getGetVtoGenerationsGenerationIdQueryKey,
  getVtoGenerationsGenerationId,
  usePostVtoGenerations,
  useGetVtoGenerationsGenerationId,
} from '../api/endpoints/vto/vto';
import type { PostVtoGenerationsBody } from '../api/model/postVtoGenerationsBody';
import type { VtoStatusResponse } from '../api/model/vtoStatusResponse';
import type { VtoStatusResponseStatus } from '../api/model/vtoStatusResponseStatus';
import { useQueryClient } from '@tanstack/react-query';
import { connectSse } from '../lib/sse';
import { mergeVtoStatus } from '../lib/status-arbitration';

/** A terminal status needs no reconnect: the stream that reported it is done. */
function isTerminalStatus(data: VtoStatusResponse): boolean {
  return data.status === 'Complete' || data.status === 'Failed';
}

export default function useVtoGeneration() {
  const queryClient = useQueryClient();
  const [vtoId, setVtoId] = useState<string | null>(null);
  const sseRef = useRef<ReturnType<typeof connectSse> | null>(null);

  const generateMutation = usePostVtoGenerations();

  const statusQuery = useGetVtoGenerationsGenerationId(vtoId ?? '', {
    query: {
      enabled: !!vtoId,
      queryFn: async ({ signal }) => {
        if (!vtoId) throw new Error('A VTO generation id is required to read its status');
        const fetched = await getVtoGenerationsGenerationId(vtoId, undefined, signal);
        // The 10-second read is a fallback, not a second writer: it resolves
        // through the same arbiter as the stream, so a request that started
        // before a newer terminal frame returns the cached terminal status.
        const cached = queryClient.getQueryData<VtoStatusResponse>(
          getGetVtoGenerationsGenerationIdQueryKey(vtoId),
        );
        return mergeVtoStatus(cached, fetched);
      },
      refetchInterval: (query) => {
        if (!vtoId) return false;
        const data = query.state.data as VtoStatusResponse | undefined;
        return data?.status === 'Complete' || data?.status === 'Failed' ? false : 10_000;
      },
    },
  });

  const status: VtoStatusResponseStatus | null = statusQuery.data?.status ?? null;
  const isTerminal = status === 'Complete' || status === 'Failed';

  const invalidateProfile = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['/users/me'] as const });
  }, [queryClient]);

  useEffect(() => {
    sseRef.current?.close();
    sseRef.current = null;

    if (!vtoId || isTerminal) return;

    const queryKey = getGetVtoGenerationsGenerationIdQueryKey(vtoId);

    sseRef.current = connectSse<VtoStatusResponse>(
      `/vto/generations/${vtoId}/stream`,
      (data) => {
        // Only `event: status` frames reach this callback. Both channels merge
        // through the arbiter: a duplicate or out-of-order frame leaves the newer
        // cached state in place, and an equal version refreshes the signed URL.
        const cached = queryClient.getQueryData<VtoStatusResponse>(queryKey);
        const merged = mergeVtoStatus(cached, data);
        if (merged === cached) return;
        queryClient.setQueryData(queryKey, merged);
      },
      {
        eventName: 'status',
        // Close on the status that is actually held: an older terminal frame
        // cannot close a stream whose newer lifecycle just started.
        isTerminal: (data) => {
          const cached = queryClient.getQueryData<VtoStatusResponse>(queryKey);
          return isTerminalStatus(mergeVtoStatus(cached, data));
        },
      },
    );

    return () => {
      sseRef.current?.close();
      sseRef.current = null;
    };
  }, [vtoId, queryClient, isTerminal, invalidateProfile]);

  // The balance changes on generation start and again when the run settles
  // (deduction, refund, exhaustion), so re-read the profile at both points.
  // The History list keeps the row it last fetched, which can still say the run
  // is in flight, so the settle also schedules exactly one list read to
  // reconcile the page. The card does not wait for it: its row is derived from
  // the terminal status at render. `isTerminal` flips once per generation, so
  // this adds one read per settle — never one per frame or per poll — and a
  // read already in flight is joined rather than duplicated.
  useEffect(() => {
    if (!vtoId || !isTerminal) return;
    invalidateProfile();
    queryClient.invalidateQueries({ queryKey: ['/vto/generations'] as const });
  }, [vtoId, isTerminal, invalidateProfile, queryClient]);

  const result: VtoStatusResponse | null = statusQuery.data ?? null;
  const errorMessage: string | null = statusQuery.data?.error_message ?? (generateMutation.isError ? 'Failed to start generation' : null);
  const isPolling = !!vtoId && !isTerminal;

  const generate = useCallback(async (params: PostVtoGenerationsBody) => {
    setVtoId(null);
    const response = await generateMutation.mutateAsync({ data: params });
    setVtoId(response.generation_id);
    queryClient.invalidateQueries({ queryKey: ['/vto/generations'] as const });
    invalidateProfile();
  }, [generateMutation, queryClient, invalidateProfile]);

  return { generate, status, result, errorMessage, isPolling, isTerminal, vtoId, isStarting: generateMutation.isPending };
}
