import { fetchAuthSession } from 'aws-amplify/auth';
import { CLIENT_VERSION, CLIENT_VERSION_HEADER } from './client-version';

type SseEventCallback<T = unknown> = (data: T) => void;

export type SseConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

interface SseConnection {
  close: () => void;
}

interface SseConnectionOptions<T = unknown> {
  initialRetryMs?: number;
  maxRetryMs?: number;
  /**
   * How long a stream may go without any frame — a `status` frame, a
   * `heartbeat` frame or any other event — before the request is aborted and
   * reconnected through the normal backoff path. The Service heartbeats every
   * 15 seconds, inside CloudFront's 60-second origin read timeout, so 45
   * seconds without a frame means a half-open socket rather than a quiet one.
   */
  idleTimeoutMs?: number;
  /**
   * Only frames whose SSE `event` field names this event reach the callback.
   * The Service interleaves `event: heartbeat` frames (`data: {}`) with the
   * `event: status` frames that carry state, and a heartbeat must never replace
   * cached state.
   */
  eventName?: string;
  /**
   * A dispatched payload after which no reconnect can change the resource. The
   * connection closes without retrying, so a terminal frame does not reopen the
   * stream that produced it.
   */
  isTerminal?: (data: T) => boolean;
  onError?: (error: unknown) => void;
  onStateChange?: (state: SseConnectionState) => void;
}

interface SseFrame {
  event: string;
  data: string;
}

/**
 * The Service rejected this Client's version identity. No reconnect can fix a
 * version mismatch, so this error ends the stream instead of retrying.
 */
export class ClientVersionUnsupportedError extends Error {
  constructor() {
    super('CLIENT_VERSION_UNSUPPORTED: the Service rejected this Client version');
    this.name = 'ClientVersionUnsupportedError';
  }
}

/**
 * The stream answered no frame of any kind inside the idle window. The request
 * is aborted and the connection reconnects with the usual backoff.
 */
export class SseIdleTimeoutError extends Error {
  constructor(idleTimeoutMs: number) {
    super(`No SSE frame arrived within ${idleTimeoutMs} ms; reconnecting`);
    this.name = 'SseIdleTimeoutError';
  }
}

/** Whether `response` is the terminal Client-version rejection. */
async function isClientVersionUnsupported(response: Response): Promise<boolean> {
  if (response.status !== 400) return false;
  try {
    const body: unknown = await response.json();
    return typeof body === 'object'
      && body !== null
      && (body as { error?: unknown }).error === 'CLIENT_VERSION_UNSUPPORTED';
  } catch {
    return false;
  }
}

function parseEventFrame(frame: string): SseFrame | null {
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).replace(/^ /, '');
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
    }
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/** Dispatches one frame; returns whether it was the caller's terminal payload. */
function dispatchFrame<T>(
  frame: string,
  onEvent: SseEventCallback<T>,
  eventName: string | undefined,
  isTerminal: ((data: T) => boolean) | undefined,
): boolean {
  const parsed = parseEventFrame(frame);
  if (!parsed) return false;
  if (eventName !== undefined && parsed.event !== eventName) return false;

  let data: T;
  try {
    data = JSON.parse(parsed.data) as T;
  } catch {
    // Malformed events are ignored; the stream remains usable.
    return false;
  }

  onEvent(data);
  return isTerminal?.(data) === true;
}

/** Why an SSE response stopped. */
type ConsumeOutcome = 'terminal' | 'ended' | 'idle';

/**
 * Reads one SSE response until a terminal payload, the end of the stream, or
 * the idle watchdog fires.
 */
async function consumeEventStream<T>(
  response: Response,
  controller: AbortController,
  onEvent: SseEventCallback<T>,
  options: SseConnectionOptions<T>,
): Promise<ConsumeOutcome> {
  if (!response.body) throw new Error('SSE response has no body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const idleTimeoutMs = options.idleTimeoutMs ?? 45_000;
  let buffer = '';
  let trailingCr = false;
  let lastFrameAt = Date.now();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimedOut = false;

  const armIdleTimer = (delay = idleTimeoutMs): void => {
    idleTimer = setTimeout(() => {
      idleTimer = null;
      const idleFor = Date.now() - lastFrameAt;
      if (idleFor < idleTimeoutMs) {
        // A frame landed after this check was armed (a timer may fire late).
        armIdleTimer(idleTimeoutMs - idleFor);
        return;
      }
      idleTimedOut = true;
      controller.abort();
    }, delay);
  };

  /**
   * Records that a frame of any kind arrived, before the event-name filter can
   * discard it. A heartbeat is never passed to the callback, but it is exactly
   * what proves a half-open stream is still alive.
   */
  const noteAnyFrame = (): void => {
    lastFrameAt = Date.now();
    if (idleTimer !== null) clearTimeout(idleTimer);
    armIdleTimer();
  };

  armIdleTimer();

  try {
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (idleTimedOut) return 'idle';
      if (controller.signal.aborted) return 'ended';

      // A trailing CR may be the first half of a CRLF split across chunks.
      let chunk: string = (trailingCr ? '\r' : '') + decoder.decode(value, { stream: !done });
      trailingCr = !done && chunk.endsWith('\r');
      if (trailingCr) chunk = chunk.slice(0, -1);
      buffer += chunk.replace(/\r\n?/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (!controller.signal.aborted && boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        noteAnyFrame();
        if (dispatchFrame(frame, onEvent, options.eventName, options.isTerminal)) return 'terminal';
        boundary = buffer.indexOf('\n\n');
      }
      if (done) return 'ended';
    }

    return 'ended';
  } catch (error) {
    if (idleTimedOut) return 'idle';
    throw error;
  } finally {
    if (idleTimer !== null) clearTimeout(idleTimer);
  }
}

/**
 * Opens an authenticated, reconnecting SSE connection to the API.
 */
export function connectSse<T = unknown>(
  path: string,
  onEvent: SseEventCallback<T>,
  options: SseConnectionOptions<T> = {},
): SseConnection {
  const initialRetryMs = options.initialRetryMs ?? 1_000;
  const maxRetryMs = options.maxRetryMs ?? 30_000;
  let closed = false;
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let activeController: AbortController | null = null;

  const setState = (state: SseConnectionState) => options.onStateChange?.(state);

  /** Ends the connection without a reconnect. Returns false when already closed. */
  const closeConnection = (): boolean => {
    if (closed) return false;
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    activeController?.abort();
    activeController = null;
    setState('closed');
    return true;
  };

  const scheduleReconnect = (): void => {
    if (closed || retryTimer) return;

    setState('reconnecting');
    const exponentialDelay = Math.min(initialRetryMs * (2 ** retryAttempt), maxRetryMs);
    const jitteredDelay = Math.round(exponentialDelay * (0.8 + Math.random() * 0.4));
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void run(false);
    }, jitteredDelay);
  };

  /** Ends the connection without a reconnect: no retry can change the response. */
  const closeTerminally = (error: unknown): void => {
    if (closeConnection()) options.onError?.(error);
  };

  const run = async (forceRefresh: boolean): Promise<void> => {
    if (closed) return;

    setState(retryAttempt === 0 ? 'connecting' : 'reconnecting');
    const controller = new AbortController();
    activeController = controller;

    try {
      const session = forceRefresh
        ? await fetchAuthSession({ forceRefresh: true })
        : await fetchAuthSession();
      const token = session.tokens?.accessToken?.toString();
      if (!token) throw new Error('No access token is available for SSE');
      if (closed) return;

      const baseUrl = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
      const normalizedPath = path.startsWith('/') ? path : `/${path}`;
      const response = await fetch(`${baseUrl}${normalizedPath}`, {
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${token}`,
          [CLIENT_VERSION_HEADER]: String(CLIENT_VERSION),
        },
        signal: controller.signal,
      });

      if (await isClientVersionUnsupported(response)) {
        throw new ClientVersionUnsupportedError();
      }
      if ((response.status === 401 || response.status === 403) && !forceRefresh) {
        await run(true);
        return;
      }
      if (!response.ok) throw new Error(`SSE connection failed with status ${response.status}`);

      retryAttempt = 0;
      setState('open');
      const outcome = await consumeEventStream(response, controller, onEvent, options);
      if (outcome === 'terminal') {
        closeConnection();
      } else if (outcome === 'idle') {
        // A half-open socket: abort above, then reconnect through the same
        // bounded-backoff path as any transient stream failure.
        options.onError?.(new SseIdleTimeoutError(options.idleTimeoutMs ?? 45_000));
        scheduleReconnect();
      } else {
        scheduleReconnect();
      }
    } catch (error) {
      if (closed || (error instanceof Error && error.name === 'AbortError')) return;
      if (error instanceof ClientVersionUnsupportedError) {
        closeTerminally(error);
        return;
      }
      options.onError?.(error);
      scheduleReconnect();
    } finally {
      if (activeController === controller) activeController = null;
    }
  };

  void run(false);

  return {
    close: () => {
      closeConnection();
    },
  };
}
