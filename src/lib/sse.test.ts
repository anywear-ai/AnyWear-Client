import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAuthSession } from 'aws-amplify/auth';
import { ClientVersionUnsupportedError, SseIdleTimeoutError, connectSse } from './sse';
import { CLIENT_VERSION } from './client-version';

vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession: vi.fn(),
}));

const encoder = new TextEncoder();

function eventStream(chunks: string[]): Response {
  return new Response(new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('connectSse', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(fetchAuthSession).mockResolvedValue({
      tokens: { accessToken: { toString: () => 'access-token' } },
    } as Awaited<ReturnType<typeof fetchAuthSession>>);
  });

  it('parses framed and multi-line JSON events across chunks', async () => {
    const onEvent = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(eventStream([
      ': heartbeat\r\n\r\ndata: not-json\r\n\r\ndata: {"status":\r\n',
      'data: "Complete"}\r\n\r\n',
    ])));

    const connection = connectSse('/events', (event) => {
      onEvent(event);
      connection.close();
    }, { initialRetryMs: 60_000 });

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith({ status: 'Complete' }));
  });

  it('refreshes authentication immediately after an unauthorized response', async () => {
    const onEvent = vi.fn();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(eventStream(['data: {"status":"ready"}\n\n'])));

    const connection = connectSse('/events', (event) => {
      onEvent(event);
      connection.close();
    }, { initialRetryMs: 60_000 });

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith({ status: 'ready' }));
    expect(fetchAuthSession).toHaveBeenNthCalledWith(2, { forceRefresh: true });
  });

  it('sends the Client version header on the stream request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(eventStream(['data: {"status":"Complete"}\n\n']));
    vi.stubGlobal('fetch', fetchMock);

    const connection = connectSse('/events', () => connection.close(), { initialRetryMs: 60_000 });
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(fetchMock.mock.calls[0][1]).toMatchObject({
        headers: {
          Accept: 'text/event-stream',
          'X-AnyWear-Client-Version': String(CLIENT_VERSION),
        },
      });
    } finally {
      connection.close();
    }
  });

  it('reconnects after a transient response failure', async () => {
    const onEvent = vi.fn();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(eventStream(['data: {"status":"Processing"}\n\n'])));

    const connection = connectSse('/events', (event) => {
      onEvent(event);
      connection.close();
    }, { initialRetryMs: 1, maxRetryMs: 1 });

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith({ status: 'Processing' }));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('treats a CLIENT_VERSION_UNSUPPORTED 400 as terminal', async () => {
    const onEvent = vi.fn();
    const onError = vi.fn();
    const onStateChange = vi.fn();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'CLIENT_VERSION_UNSUPPORTED' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    connectSse('/events', onEvent, {
      initialRetryMs: 1,
      maxRetryMs: 1,
      onError,
      onStateChange,
    });

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    const error = onError.mock.calls[0][0];
    expect(error).toBeInstanceOf(ClientVersionUnsupportedError);
    expect(String(error)).toContain('CLIENT_VERSION_UNSUPPORTED');

    // A retry would be scheduled within a couple of milliseconds; wait longer
    // than that and prove the connection stayed closed.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith('closed');
    expect(onStateChange).not.toHaveBeenCalledWith('reconnecting');
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('reconnects after a 400 that is not a Client version rejection', async () => {
    const onEvent = vi.fn();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'SOMETHING_ELSE' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ))
      .mockResolvedValueOnce(eventStream(['data: {"status":"Complete"}\n\n']));
    vi.stubGlobal('fetch', fetchMock);

    const connection = connectSse('/events', (event) => {
      onEvent(event);
      connection.close();
    }, { initialRetryMs: 1, maxRetryMs: 1 });

    try {
      await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith({ status: 'Complete' }));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      connection.close();
    }
  });

  it('reconnects after the server disconnects an open stream', async () => {
    const receivedStatuses: string[] = [];
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(eventStream(['data: {"status":"Processing"}\n\n']))
      .mockResolvedValueOnce(eventStream(['data: {"status":"Complete"}\n\n'])));

    const connection = connectSse<{ status: string }>('/events', (event) => {
      receivedStatuses.push(event.status);
      if (event.status === 'Complete') connection.close();
    }, { initialRetryMs: 1, maxRetryMs: 1 });

    await vi.waitFor(() => expect(receivedStatuses).toEqual(['Processing', 'Complete']));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['split CRLF within multiline JSON', ['data: {"status":\r', '\ndata: "Complete"}\r\n\r\n']],
    ['split CRLF at the frame boundary', ['data: {"status":"Complete"}\r\n\r', '\n']],
    ['CR-only frame boundary at EOF', ['data: {"status":"Complete"}\r\r']],
  ])('parses %s', async (_name, chunks) => {
    const onEvent = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(eventStream(chunks as string[])));
    const connection = connectSse('/events', onEvent, { initialRetryMs: 60_000 });
    try {
      await vi.waitFor(() => expect(onEvent).toHaveBeenCalledExactlyOnceWith({ status: 'Complete' }));
    } finally {
      connection.close();
    }
  });

  it('does not dispatch another buffered frame after a terminal callback closes the connection', async () => {
    const onEvent = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(eventStream([
      'data: {"status":"Complete","state_version":3}\n\n'
      + 'data: {"status":"Processing","state_version":2}\n\n',
    ])));
    const connection = connectSse('/events', (event) => {
      onEvent(event);
      connection.close();
    });
    try {
      await vi.waitFor(() => expect(onEvent).toHaveBeenCalledExactlyOnceWith({ status: 'Complete', state_version: 3 }));
    } finally {
      connection.close();
    }
  });

  it('dispatches only the event name the caller asked for', async () => {
    const onEvent = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(eventStream([
      'event: heartbeat\ndata: {}\n\n',
      'event: status\ndata: {"status":"Processing","state_version":2}\n\n',
      'event: heartbeat\ndata: {}\n\n',
    ])));

    const connection = connectSse('/events', (event) => {
      onEvent(event);
      connection.close();
    }, { eventName: 'status', initialRetryMs: 60_000 });

    try {
      await vi.waitFor(() => expect(onEvent).toHaveBeenCalledExactlyOnceWith({
        status: 'Processing',
        state_version: 2,
      }));
    } finally {
      connection.close();
    }
  });

  it('ends without reconnecting after a terminal payload', async () => {
    const onEvent = vi.fn();
    const onStateChange = vi.fn();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetchMock = vi.fn().mockResolvedValue(eventStream([
      'event: status\ndata: {"status":"Complete","state_version":4}\n\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);

    connectSse<{ status: string }>('/events', onEvent, {
      eventName: 'status',
      isTerminal: (event) => event.status === 'Complete',
      initialRetryMs: 1,
      maxRetryMs: 1,
      onStateChange,
    });

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledExactlyOnceWith({
      status: 'Complete',
      state_version: 4,
    }));
    await vi.waitFor(() => expect(onStateChange).toHaveBeenCalledWith('closed'));
    // A retry would be scheduled within a couple of milliseconds; wait longer
    // than that and prove the terminal frame did not reopen the stream.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onStateChange).not.toHaveBeenCalledWith('reconnecting');
  });

  /**
   * A stream that stays open until the request's signal aborts, which errors it
   * the same way a real aborted `fetch` body does.
   */
  function silentStream(
    signals: AbortSignal[],
    controllers: ReadableStreamDefaultController<Uint8Array>[] = [],
  ): typeof fetch {
    return (async (_input: RequestInfo | URL, options?: RequestInit) => {
      const signal = options?.signal as AbortSignal;
      signals.push(signal);
      return new Response(new ReadableStream({
        start(controller) {
          controllers.push(controller);
          signal.addEventListener('abort', () => {
            try {
              controller.error(new DOMException('Aborted', 'AbortError'));
            } catch {
              // The stream may already be closed.
            }
          });
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
  }

  it('aborts a stream with no frame of any kind for 45 seconds and reconnects', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const signals: AbortSignal[] = [];
      const onEvent = vi.fn();
      const onError = vi.fn();
      const fetchMock = vi.fn(silentStream(signals));
      vi.stubGlobal('fetch', fetchMock);

      connectSse('/events', onEvent, {
        // The production window, advanced explicitly below.
        idleTimeoutMs: 45_000,
        initialRetryMs: 1,
        maxRetryMs: 1,
        onError,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // A frame may be due at any moment inside the window; 44.999 s is still
      // silent but not yet a half-open socket.
      await vi.advanceTimersByTimeAsync(44_999);
      expect(signals[0].aborted).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2);
      expect(signals[0].aborted).toBe(true);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0]).toBeInstanceOf(SseIdleTimeoutError);

      // The abort routes through the existing backoff path, not a new one.
      await vi.advanceTimersByTimeAsync(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(onEvent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a filtered stream alive on frames the eventName filter discards', async () => {
    const signals: AbortSignal[] = [];
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const onEvent = vi.fn();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetchMock = vi.fn(silentStream(signals, controllers));
    vi.stubGlobal('fetch', fetchMock);

    const connection = connectSse('/events', onEvent, {
      eventName: 'status',
      idleTimeoutMs: 200,
      initialRetryMs: 1,
      maxRetryMs: 1,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Heartbeats never reach the callback, but every one of them resets the
      // idle window because it is recorded before the event-name filter.
      for (let index = 0; index < 6; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        controllers[0].enqueue(encoder.encode('event: heartbeat\ndata: {}\n\n'));
      }
      expect(onEvent).not.toHaveBeenCalled();
      expect(signals[0].aborted).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Once the heartbeats stop, the watchdog fires and the stream reconnects.
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(signals[0].aborted).toBe(true);
      for (let index = 0; index < 100 && fetchMock.mock.calls.length < 2; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(onEvent).not.toHaveBeenCalled();
    } finally {
      connection.close();
    }
  });
});
