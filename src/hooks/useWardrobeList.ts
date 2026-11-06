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
 * newer item.
 *
 * Triggers that land together collapse into one read. A trigger that lands while
 * a read is in flight queues exactly one trailing merged read, because that
 * read's snapshot may predate the write the trigger reports: a confirmation
 * committed during an earlier read must still reach the cache.
 *
 * Generated hooks are the network boundary; this module adds only the merge, the
 * trigger collection and the coalescing around them.
 */
export interface WardrobeList {
  /** The cached list, merged per item. */
  items: GetWardrobe200Item[];
  isLoading: boolean;
  /**
   * One merged `GET /wardrobe`. A trigger during an in-flight read schedules one
   * trailing read and joins the read that is running.
   */
  refetch: () => Promise<unknown>;
  /**
   * Feeds the aggregate stream's connection states in. Opening the stream after
   * a reconnect — including an open that follows failed initial attempts — is a
   * recovery trigger; a first open that never had to reconnect follows the mount
   * read, and so does a reopen after a clean close.
   */
  notifyStreamState: (state: SseConnectionState) => void;
}

export function useWardrobeList(filters: GetWardrobeParams): WardrobeList {
  const queryClient = useQueryClient();
  const queryKey = getGetWardrobeQueryKey(filters);
  const inFlight = useRef<Promise<unknown> | null>(null);
  const trailingRead = useRef(false);
  const streamOpened = useRef(false);
  const streamReconnecting = useRef(false);

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
    if (inFlight.current) {
      // This read's snapshot may predate the write that just asked for a
      // refresh, so joining it is not enough: one trailing read runs after it
      // settles. Every trigger that arrives before that trailing read starts
      // collapses into the same one.
      trailingRead.current = true;
      return inFlight.current;
    }

    const readLoop = (async (): Promise<void> => {
      do {
        trailingRead.current = false;
        try {
          await refetchRef.current();
        } catch {
          // The query records its own failure for the page to show; a trigger
          // must never surface as an unhandled rejection.
        }
      } while (trailingRead.current);
      inFlight.current = null;
    })();

    inFlight.current = readLoop;
    return readLoop;
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
    if (state === 'reconnecting') {
      // The stream dropped or never opened. An `open` after this is a recovery
      // even when no open was seen before it: no stream was carrying frames
      // while the list could have changed.
      streamReconnecting.current = true;
      return;
    }
    if (state === 'open') {
      const recovered = streamReconnecting.current;
      streamReconnecting.current = false;
      if (recovered || streamOpened.current) {
        // A reopen after a reconnect (or a second open on an already-live
        // stream) is a recovery trigger; the mount read already answered a
        // clean first open, and a reopen after a clean close follows the read
        // that page's own actions made.
        void refetch();
      }
      streamOpened.current = true;
      return;
    }
    if (state === 'closed') {
      streamOpened.current = false;
      streamReconnecting.current = false;
    }
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
