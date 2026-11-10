import type { PropsWithChildren } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider, keepPreviousData } from '@tanstack/react-query';
import { fetchAuthSession } from 'aws-amplify/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VtoStatusResponse } from '../api/model/vtoStatusResponse';
import type { GetVtoGenerations200 } from '../api/model/getVtoGenerations200';
import { customInstance } from '../api/custom-instance';
import { useGetVtoGenerations } from '../api/endpoints/vto/vto';
import useVtoGeneration from './useVtoGeneration';

vi.mock('../api/custom-instance', () => ({ customInstance: vi.fn() }));
vi.mock('aws-amplify/auth', () => ({ fetchAuthSession: vi.fn() }));

const pendingStatus: VtoStatusResponse = {
  generation_id: 'generation-1',
  status: 'Processing',
  state_version: 1,
  imageId: null,
  url: null,
  created_at: '2026-10-03T00:00:00.000Z',
  rating: null,
};

const SETTLED_URL = 'https://images.example.com/generation-1.jpg';

const historyPage: GetVtoGenerations200 = {
  generations: [
    {
      id: 'generation-1',
      createdAt: '2026-10-03T00:00:00.000Z',
      status: 'Pending',
      imageId: null,
      url: null,
      rating: null,
      promptUsed: null,
      advancedSettings: null,
      items: [],
    },
  ],
  total: 1,
  page: 1,
  limit: 12,
  nextPage: null,
};

function createWrapper(queryClient: QueryClient) {
  return function QueryClientWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useVtoGeneration recovery lifecycle', () => {
  const clients: QueryClient[] = [];
  let getStatus: ReturnType<typeof vi.fn<() => Promise<VtoStatusResponse>>>;
  let streamFetch: ReturnType<typeof vi.fn<typeof fetch>>;
  let streamSignals: AbortSignal[];
  let streamControllers: ReadableStreamDefaultController<Uint8Array>[];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    getStatus = vi.fn().mockResolvedValue(pendingStatus);
    streamSignals = [];
    streamControllers = [];
    vi.mocked(customInstance).mockImplementation((config) => {
      if (config.method === 'POST') {
        return Promise.resolve({ generation_id: 'generation-1', outfit_id: 'outfit-1' });
      }
      return getStatus();
    });
    vi.mocked(fetchAuthSession).mockResolvedValue({
      tokens: { accessToken: { toString: () => 'access-token' } },
    } as Awaited<ReturnType<typeof fetchAuthSession>>);
    // Real SSE stays open without events: only reconciliation GETs can finish the task.
    streamFetch = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      streamSignals.push(options?.signal as AbortSignal);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { streamControllers.push(controller); },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', streamFetch);
  });

  afterEach(() => {
    cleanup();
    clients.splice(0).forEach((client) => client.clear());
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function renderGeneration() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    clients.push(queryClient);
    return {
      queryClient,
      ...renderHook(() => useVtoGeneration(), { wrapper: createWrapper(queryClient) }),
    };
  }

  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  async function start(result: { current: ReturnType<typeof useVtoGeneration> }) {
    await act(async () => {
      await result.current.generate({ base_photo_id: 'photo-1', outfit_id: 'outfit-1' });
    });
    await advance(0);
  }

  it('does not poll or open SSE before a generation exists', async () => {
    const { result } = renderGeneration();
    await advance(30_000);
    expect(getStatus).not.toHaveBeenCalled();
    expect(streamFetch).not.toHaveBeenCalled();
    expect(result.current.isPolling).toBe(false);
  });

  it.each(['Pending', 'Processing'] as const)('polls every ten seconds with one SSE owner while %s', async (status) => {
    getStatus.mockResolvedValue({ ...pendingStatus, status });
    const { result, unmount } = renderGeneration();
    await start(result);
    expect(result.current.status).toBe(status);
    expect(result.current.isPolling).toBe(true);
    expect(getStatus).toHaveBeenCalledTimes(1);
    await advance(9_999);
    expect(getStatus).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(streamFetch).toHaveBeenCalledTimes(1);
    unmount();
    expect(streamSignals[0].aborted).toBe(true);
  });

  it.each(['Complete', 'Failed'] as const)('stops polling and aborts active SSE after GET-only %s', async (status) => {
    getStatus.mockResolvedValueOnce(pendingStatus)
      .mockResolvedValue({ ...pendingStatus, status, state_version: 2 });
    const { result } = renderGeneration();
    await start(result);
    expect(streamSignals[0].aborted).toBe(false);
    await advance(10_000);
    // Query notifications scheduled inside the polling tick run on the next clock tick.
    await advance(1);
    expect(result.current.status).toBe(status);
    expect(result.current.isPolling).toBe(false);
    expect(streamSignals[0].aborted).toBe(true);
    await advance(60_000);
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(streamFetch).toHaveBeenCalledTimes(1);
  });

  it('recovers from an initial GET failure without SSE and cancels pending reconnects at terminal', async () => {
    getStatus.mockRejectedValueOnce(new Error('GET temporarily unavailable'))
      .mockResolvedValueOnce(pendingStatus)
      .mockResolvedValue({ ...pendingStatus, status: 'Complete', state_version: 2 });
    streamFetch.mockResolvedValue(new Response(null, { status: 503 }));
    const { result, queryClient } = renderGeneration();
    await start(result);
    expect(queryClient.getQueryState(['/vto/generations/generation-1'])?.status).toBe('error');
    await advance(9_999);
    expect(getStatus).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(getStatus).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(result.current.status).toBe('Processing');
    expect(result.current.isPolling).toBe(true);
    await advance(10_000);
    await advance(1);
    expect(result.current.status).toBe('Complete');
    expect(result.current.isPolling).toBe(false);
    const attempts = streamFetch.mock.calls.length;
    expect(attempts).toBeGreaterThan(1);
    await advance(60_000);
    expect(getStatus).toHaveBeenCalledTimes(3);
    expect(streamFetch).toHaveBeenCalledTimes(attempts);
  });

  it('keeps the loading state while the initial GET has no data', async () => {
    getStatus.mockRejectedValue(new Error('GET temporarily unavailable'));
    const { result } = renderGeneration();
    await start(result);
    expect(result.current.status).toBeNull();
    expect(result.current.isPolling).toBe(true);
  });

  it.each(['Complete', 'Failed'] as const)('closes real SSE immediately on %s and ignores a buffered stale frame', async (status) => {
    const { result } = renderGeneration();
    await start(result);
    await act(async () => {
      streamControllers[0].enqueue(new TextEncoder().encode(
        `event: status\ndata: ${JSON.stringify({ ...pendingStatus, status, state_version: 3 })}\n\n`
        + `event: status\ndata: ${JSON.stringify({ ...pendingStatus, state_version: 2 })}\n\n`,
      ));
    });
    await advance(1);
    expect(result.current.status).toBe(status);
    expect(result.current.result?.state_version).toBe(3);
    expect(streamSignals[0].aborted).toBe(true);
    await advance(30_000);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(streamFetch).toHaveBeenCalledTimes(1);
  });

  it('does not let a poll that started before a terminal frame overwrite it', async () => {
    const { result } = renderGeneration();
    await start(result);
    expect(getStatus).toHaveBeenCalledTimes(1);

    // The 10-second read starts while the run is still Processing and is held
    // open; it is the request that will resolve after the newer stream frame.
    let resolvePoll!: (status: VtoStatusResponse) => void;
    getStatus.mockImplementationOnce(() => new Promise<VtoStatusResponse>((resolve) => {
      resolvePoll = resolve;
    }));
    await advance(10_000);
    expect(getStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      streamControllers[0].enqueue(new TextEncoder().encode(
        `event: status\ndata: ${JSON.stringify({
          ...pendingStatus,
          status: 'Complete',
          state_version: 3,
          imageId: 'image-9',
          url: 'https://example.com/result.jpg',
        })}\n\n`,
      ));
    });
    await advance(1);
    expect(result.current.status).toBe('Complete');
    expect(result.current.isTerminal).toBe(true);
    expect(result.current.isPolling).toBe(false);
    expect(streamSignals[0].aborted).toBe(true);
    const streamRequests = streamFetch.mock.calls.length;

    // The older poll answers last; the arbiter keeps the terminal status and
    // neither the stream nor the poll reopens against a finished run.
    await act(async () => {
      resolvePoll({ ...pendingStatus, state_version: 2 });
    });
    await advance(1);
    expect(result.current.status).toBe('Complete');
    expect(result.current.result?.state_version).toBe(3);
    expect(result.current.isTerminal).toBe(true);
    expect(result.current.isPolling).toBe(false);
    expect(streamFetch).toHaveBeenCalledTimes(streamRequests);

    await advance(60_000);
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(streamFetch).toHaveBeenCalledTimes(streamRequests);
  });

  it('does not let a heartbeat frame replace cached state', async () => {
    const { result, queryClient } = renderGeneration();
    await start(result);
    const queryKey = ['/vto/generations/generation-1'];

    await act(async () => {
      streamControllers[0].enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'));
    });
    await advance(1);

    expect(queryClient.getQueryData(queryKey)).toEqual(pendingStatus);
    expect(result.current.result).toEqual(pendingStatus);
    expect(streamSignals[0].aborted).toBe(false);
  });

  it('drops a status frame whose state_version is not newer than the cached one', async () => {
    getStatus.mockResolvedValue({ ...pendingStatus, state_version: 3 });
    const { result, queryClient } = renderGeneration();
    await start(result);
    const queryKey = ['/vto/generations/generation-1'];
    expect(queryClient.getQueryData(queryKey)).toEqual({ ...pendingStatus, state_version: 3 });

    // A duplicate or out-of-order frame leaves the newer cached state in place.
    await act(async () => {
      streamControllers[0].enqueue(new TextEncoder().encode(
        `event: status\ndata: ${JSON.stringify({ ...pendingStatus, status: 'Pending', state_version: 2 })}\n\n`,
      ));
    });
    await advance(1);
    expect(result.current.status).toBe('Processing');
    expect(result.current.result?.state_version).toBe(3);

    // A newer frame is applied.
    await act(async () => {
      streamControllers[0].enqueue(new TextEncoder().encode(
        `event: status\ndata: ${JSON.stringify({ ...pendingStatus, status: 'Pending', state_version: 4 })}\n\n`,
      ));
    });
    await advance(1);
    expect(result.current.status).toBe('Pending');
    expect(result.current.result?.state_version).toBe(4);
  });

  it('aborts on unmount and ignores a frame arriving after the pending read', async () => {
    const { result, unmount, queryClient } = renderGeneration();
    await start(result);
    unmount();
    expect(streamSignals[0].aborted).toBe(true);
    streamControllers[0].enqueue(new TextEncoder().encode(
      `event: status\ndata: ${JSON.stringify({ ...pendingStatus, status: 'Complete', state_version: 2 })}\n\n`,
    ));
    await advance(30_000);
    expect(queryClient.getQueryData(['/vto/generations/generation-1'])).toEqual(pendingStatus);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(streamFetch).toHaveBeenCalledTimes(1);
  });

  it('invalidates the profile query on generate and on terminal status', async () => {
    getStatus.mockResolvedValueOnce(pendingStatus)
      .mockResolvedValue({ ...pendingStatus, status: 'Complete', state_version: 2 });
    const { result, queryClient } = renderGeneration();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await start(result);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['/users/me'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['/vto/generations'] });

    await advance(10_000);
    await advance(1);
    expect(result.current.status).toBe('Complete');
    expect(invalidate.mock.calls.filter(([arg]) => arg?.queryKey?.[0] === '/users/me').length)
      .toBeGreaterThanOrEqual(2);
  });

  function renderGenerationWithHistory() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    clients.push(queryClient);
    return {
      queryClient,
      ...renderHook(
        () => ({
          generation: useVtoGeneration(),
          // The same read `useVtoHistory` mounts, keyed under `/vto/generations`.
          history: useGetVtoGenerations(
            { page: 1, limit: 12 },
            { query: { placeholderData: keepPreviousData } },
          ),
        }),
        { wrapper: createWrapper(queryClient) },
      ),
    };
  }

  /** Routes `customInstance` by URL, counting `GET /vto/generations` through `getHistory`. */
  function routeHistoryReads(
    getHistory: ReturnType<typeof vi.fn<() => Promise<GetVtoGenerations200>>>,
  ) {
    vi.mocked(customInstance).mockImplementation((config) => {
      if (config.method === 'GET' && config.url === '/vto/generations') return getHistory();
      if (config.method === 'POST') {
        return Promise.resolve({ generation_id: 'generation-1', outfit_id: 'outfit-1' });
      }
      return getStatus();
    });
  }

  async function startGeneration(generation: ReturnType<typeof useVtoGeneration>) {
    await act(async () => {
      await generation.generate({ base_photo_id: 'photo-1', outfit_id: 'outfit-1' });
    });
    await advance(0);
  }

  async function sendFrame(payload: VtoStatusResponse) {
    await act(async () => {
      streamControllers[0].enqueue(new TextEncoder().encode(
        `event: status\ndata: ${JSON.stringify(payload)}\n\n`,
      ));
    });
    await advance(1);
  }

  it('adds exactly one history read at the settle, and none for frames or polls', async () => {
    const getHistory = vi.fn<() => Promise<GetVtoGenerations200>>().mockResolvedValue(historyPage);
    routeHistoryReads(getHistory);
    const { result } = renderGenerationWithHistory();

    await advance(1);
    expect(result.current.history.data).toEqual(historyPage);

    await startGeneration(result.current.generation);
    await advance(1);
    expect(result.current.generation.status).toBe('Processing');
    // The mount read, then the one the start already schedules. This is the
    // baseline the settle's delta is measured from.
    const baseline = getHistory.mock.calls.length;
    expect(baseline).toBe(2);

    // Two non-terminal frames and one 10-second poll add no history read.
    await sendFrame({ ...pendingStatus, state_version: 2 });
    await sendFrame({ ...pendingStatus, status: 'Pending', state_version: 3 });
    await advance(10_000);
    await advance(1);
    expect(result.current.generation.status).toBe('Pending');
    expect(result.current.generation.isTerminal).toBe(false);
    expect(getHistory.mock.calls.length).toBe(baseline);

    // The terminal frame adds exactly one.
    await sendFrame({
      ...pendingStatus,
      status: 'Complete',
      state_version: 4,
      imageId: 'image-1',
      url: SETTLED_URL,
    });
    expect(result.current.generation.isTerminal).toBe(true);
    expect(getHistory.mock.calls.length).toBe(baseline + 1);

    // A duplicate terminal frame and a further 60 seconds add none.
    await sendFrame({
      ...pendingStatus,
      status: 'Complete',
      state_version: 4,
      imageId: 'image-1',
      url: SETTLED_URL,
    });
    await advance(60_000);
    expect(result.current.generation.status).toBe('Complete');
    expect(getHistory.mock.calls.length).toBe(baseline + 1);
  });

  it('joins the first history read in flight instead of issuing another at the settle', async () => {
    let resolveFirstPage!: (page: GetVtoGenerations200) => void;
    const getHistory = vi.fn<() => Promise<GetVtoGenerations200>>()
      .mockResolvedValue(historyPage)
      .mockImplementationOnce(() => new Promise<GetVtoGenerations200>((resolve) => {
        resolveFirstPage = resolve;
      }));
    routeHistoryReads(getHistory);
    const { result } = renderGenerationWithHistory();

    await advance(1);
    expect(getHistory).toHaveBeenCalledTimes(1);
    expect(result.current.history.data).toBeUndefined();

    await startGeneration(result.current.generation);
    await advance(1);
    expect(streamControllers).toHaveLength(1);
    // The start invalidation joined the held read rather than duplicating it.
    expect(getHistory).toHaveBeenCalledTimes(1);

    await sendFrame({
      ...pendingStatus,
      status: 'Complete',
      state_version: 2,
      imageId: 'image-1',
      url: SETTLED_URL,
    });
    expect(result.current.generation.isTerminal).toBe(true);
    // The settle invalidation joins the same held read: no request is issued.
    expect(getHistory).toHaveBeenCalledTimes(1);

    await act(async () => { resolveFirstPage(historyPage); });
    await advance(1);
    expect(result.current.history.data).toEqual(historyPage);
    expect(getHistory).toHaveBeenCalledTimes(1);
  });
});
