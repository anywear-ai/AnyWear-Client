import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetWardrobeQueryKey,
  getWardrobe,
  useGetWardrobe,
} from '../api/endpoints/wardrobe/wardrobe';
import type { GetWardrobe200Item } from '../api/model/getWardrobe200Item';
import type { GetWardrobeParams } from '../api/model/getWardrobeParams';
import type { SseConnectionState } from '../lib/sse';
import { mergeWardrobeListResponse } from '../lib/status-arbitration';

/**
 * The single owner of the wardrobe list query.
 *
 * The aggregate status stream pushes every in-flight item's current state, so the
 * page schedules no list interval. The list is read once on mount and again on
 * each recovery trigger — the stream reopening after a reconnect, the document
 * becoming visible, the network coming back, and the app resuming or its OS
 * window regaining focus — and every response is merged per item through the
 * status arbiter, so a list read that resolves after a newer frame keeps the
 * newer item. Concurrent triggers collapse into the one in-flight read.
 *
 * Generated hooks are the network boundary; this module adds only the merge, the
 * trigger collection and the coalescing around them.
 */
export interface WardrobeList {
  /** The cached list, merged per item. */
  items: GetWardrobe200Item[];
  isLoading: boolean;
  /** One merged `GET /wardrobe`; a trigger during an in-flight read joins it. */
  refetch: () => Promise<unknown>;
  /**
   * Feeds the aggregate stream's connection states in. Opening the stream after
   * a reconnect is a recovery trigger; the initial open follows the mount read.
   */
  notifyStreamState: (state: SseConnectionState) => void;
}

export function useWardrobeList(filters: GetWardrobeParams): WardrobeList {
  const queryClient = useQueryClient();
  const queryKey = getGetWardrobeQueryKey(filters);
  const inFlight = useRef<Promise<unknown> | null>(null);
  const streamOpened = useRef(false);

  const wardrobeQuery = useGetWardrobe(filters, {
    query: {
      // The aggregate stream is the status source; a steady-state interval would
      // read the whole wardrobe and re-sign every URL it already knows.
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      queryFn: async ({ signal }) => {
        const fetched = await getWardrobe(filters, undefined, signal);
        // The cache is read when the response resolves, not when the request
        // starts: a frame applied while this read was in flight is newer than
        // the response, and the arbiter keeps it.
        const held = queryClient.getQueryData<GetWardrobe200Item[]>(queryKey);
        return mergeWardrobeListResponse(held, fetched);
      },
    },
  });

  // `refetch` keeps one identity across renders so the recovery triggers below
  // and the page's stream effect do not tear down their subscriptions.
  const refetchRef = useRef(wardrobeQuery.refetch);
  useEffect(() => {
    refetchRef.current = wardrobeQuery.refetch;
  });

  const refetch = useCallback((): Promise<unknown> => {
    // Triggers that land together are one read, not one each.
    if (inFlight.current) return inFlight.current;
    const request = refetchRef.current();
    const pending: Promise<unknown> = request.finally(() => {
      if (inFlight.current === pending) inFlight.current = null;
    });
    inFlight.current = pending;
    return pending;
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refetch();
    };
    // `online` is network recovery; `focus` is the app resuming or its OS window
    // regaining focus, which the webview surfaces as the window's focus event.
    const onOnline = () => { void refetch(); };
    const onFocus = () => { void refetch(); };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onFocus);
    };
  }, [refetch]);

  const notifyStreamState = useCallback((state: SseConnectionState) => {
    if (state === 'open') {
      if (!streamOpened.current) {
        // The first open belongs to a stream started after a list read already
        // resolved this page; only a reopen is a recovery trigger.
        streamOpened.current = true;
        return;
      }
      void refetch();
      return;
    }
    if (state === 'closed') streamOpened.current = false;
  }, [refetch]);

  const items = useMemo<GetWardrobe200Item[]>(
    () => (Array.isArray(wardrobeQuery.data) ? wardrobeQuery.data : []),
    [wardrobeQuery.data],
  );

  return {
    items,
    isLoading: wardrobeQuery.isLoading,
    refetch,
    notifyStreamState,
  };
}
