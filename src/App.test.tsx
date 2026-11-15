// @vitest-environment jsdom
import { useEffect, useRef } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosAdapter, AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import Axios from 'axios';
import { fetchAuthSession, getCurrentUser, signOut } from 'aws-amplify/auth';
import App from './App';
import { AXIOS_INSTANCE, customInstance } from './api/custom-instance';
import { useGetOutfits } from './api/endpoints/outfits/outfits';
import useVtoGeneration from './hooks/useVtoGeneration';
import { useWardrobeList } from './hooks/useWardrobeList';
import { outfitLookRefetchInterval, type OutfitLookState } from './lib/outfit-look';
import { useAuthStore } from './store/authStore';
import { useClientVersionRefusalStore } from './store/clientVersionRefusalStore';

vi.mock('aws-amplify/auth', () => ({
  getCurrentUser: vi.fn(),
  fetchAuthSession: vi.fn(),
  signOut: vi.fn(),
}));

// The stream is the transport of the try-on status read, not the observer under
// test here; the effect that owns it still runs and still closes on unmount.
vi.mock('./lib/sse', () => ({ connectSse: vi.fn(() => ({ close: vi.fn() })) }));

/**
 * The dashboard's stand-in: the two 10-second reads the shell owns — the try-on
 * status read `useVtoGeneration` creates (`src/hooks/useVtoGeneration.ts:41-45`)
 * and the outfit-look read `WardrobePage` creates with the same interval
 * (`src/lib/outfit-look.ts:35-36`).
 */
vi.mock('./pages/dashboard/DashboardPage', () => ({
  default: function PollingDashboard() {
    const { generate } = useVtoGeneration();
    const started = useRef(false);
    useEffect(() => {
      if (started.current) return;
      started.current = true;
      void generate({ outfit_id: 'outfit-1' }).catch(() => undefined);
    }, [generate]);
    useGetOutfits({
      query: {
        refetchInterval: (query) => outfitLookRefetchInterval(
          query.state.data as { outfits?: OutfitLookState[] } | undefined,
        ),
      },
    });
    return <div>polling dashboard stub</div>;
  },
}));

/** The wardrobe's stand-in: the real list hook, so its coalescing loop runs. */
vi.mock('./pages/wardrobe/WardrobePage', () => ({
  default: function WardrobeListStub() {
    useWardrobeList({});
    return <div>wardrobe list stub</div>;
  },
}));

vi.mock('./pages/settings/SettingsPage', () => ({
  default: function SettingsStub() {
    return <div>settings stub</div>;
  },
}));

const REFUSAL = {
  minimumClientVersion: 9,
  receivedClientVersion: 8,
  detailsReported: true,
} as const;

function refusalBody(minimum: number, received: number) {
  return {
    error: 'CLIENT_VERSION_UNSUPPORTED',
    details: { minimum_client_version: minimum, received_client_version: received },
  };
}

function respond<T>(config: InternalAxiosRequestConfig, data: T, status = 200): AxiosResponse<T> {
  return { data, status, statusText: 'OK', headers: {}, config };
}

function axiosBadRequest(
  config: InternalAxiosRequestConfig,
  body: unknown,
): AxiosError {
  return new Axios.AxiosError('Request failed', 'ERR_BAD_REQUEST', config, undefined, {
    data: body,
    status: 400,
    statusText: 'Bad Request',
    headers: {},
    config,
  } as AxiosResponse);
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

/** A retryable failure the interceptor does not recognise as a refusal. */
function axiosServerError(config: InternalAxiosRequestConfig): AxiosError {
  return new Axios.AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, undefined, {
    data: { error: 'INTERNAL_ERROR' },
    status: 500,
    statusText: 'Internal Server Error',
    headers: {},
    config,
  } as AxiosResponse);
}

/** Drives one refusal through the real interceptor, outside the React tree. */
async function refuse(body: unknown): Promise<void> {
  const adapter: AxiosAdapter = async (config) => {
    throw axiosBadRequest(config, body);
  };
  await customInstance({ url: '/wardrobe', method: 'GET' }, { adapter }).catch(() => undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  useClientVersionRefusalStore.setState({ refusal: null });
  useAuthStore.setState({ isAuthenticated: false, isSigningOut: false, logoutError: null });
  window.history.pushState({}, '', '/settings');
  vi.mocked(getCurrentUser).mockResolvedValue({ username: 'test-user', userId: 'user-1' });
  vi.mocked(fetchAuthSession).mockResolvedValue({} as Awaited<ReturnType<typeof fetchAuthSession>>);
  vi.mocked(signOut).mockResolvedValue();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useClientVersionRefusalStore.setState({ refusal: null });
  window.history.pushState({}, '', '/');
});

describe('the shell while a refusal is latched', () => {
  it('replaces the whole shell: no navigation, no routed page and no route loading', async () => {
    useClientVersionRefusalStore.setState({ refusal: REFUSAL });

    render(<App />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('This app requires version 9.')).toBeInTheDocument();
    expect(screen.getByText('This build is version 8.')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(document.querySelector('nav')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText('settings stub')).toBeNull();
    expect(screen.queryByText(/Loading settings/)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    // The auth bootstrap never runs, so the splash spinner never paints.
    expect(document.querySelector('[class*="animate-spin"]')).toBeNull();
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it('is not dismissed by navigation, logout or a cleared local session', async () => {
    useClientVersionRefusalStore.setState({ refusal: REFUSAL });
    render(<App />);

    act(() => {
      // The router is not mounted, so a URL change reaches no route at all.
      window.history.pushState({}, '', '/dashboard');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    act(() => {
      useAuthStore.getState().clearLocalAuth();
      void useAuthStore.getState().logout().catch(() => undefined);
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('settings stub')).toBeNull();
    expect(screen.queryByText('polling dashboard stub')).toBeNull();
  });
});

describe('five sequential refusals', () => {
  it('produce one screen, mounted once, showing the first refusal', async () => {
    render(<App />);
    await act(async () => {
      await flushMicrotasks();
    });

    // An empty latch renders the normal, routed app.
    expect(screen.getByText('settings stub')).toBeInTheDocument();
    expect(screen.getAllByRole('navigation').length).toBeGreaterThan(0);

    await act(async () => {
      await refuse(refusalBody(9, 8));
    });
    const firstScreen = screen.getByRole('alert');
    expect(screen.getByText('This app requires version 9.')).toBeInTheDocument();
    expect(screen.getByText('This build is version 8.')).toBeInTheDocument();

    for (const [minimum, received] of [[10, 9], [11, 10], [12, 11], [13, 12]] as const) {
      await act(async () => {
        await refuse(refusalBody(minimum, received));
      });
      // The same element, not a second mount, and the first numbers stay.
      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect(screen.getByRole('alert')).toBe(firstScreen);
      expect(screen.getByText('This app requires version 9.')).toBeInTheDocument();
      expect(screen.getByText('This build is version 8.')).toBeInTheDocument();
      expect(screen.queryByText(`This app requires version ${minimum}.`)).toBeNull();
    }
  });
});

describe('the two 10-second reads', () => {
  it('fire while the shell is mounted and stop for good when the refusal replaces it', async () => {
    vi.useFakeTimers();
    window.history.pushState({}, '', '/dashboard');

    const calls: string[] = [];
    let refusing = false;
    const adapter: AxiosAdapter = async (config) => {
      const url = config.url ?? '';
      calls.push(url);
      if (refusing && (url.startsWith('/vto/generations/') || url.startsWith('/outfits'))) {
        throw axiosBadRequest(config, refusalBody(9, 8));
      }
      if (url === '/users/me') return respond(config, { id: 'user-1' });
      if (url === '/vto/generations' && config.method === 'post') {
        return respond(config, { generation_id: 'generation-1', outfit_id: 'outfit-1' });
      }
      if (url.startsWith('/vto/generations/')) {
        return respond(config, {
          generation_id: 'generation-1',
          status: 'Processing',
          state_version: 1,
          imageId: null,
          url: null,
          created_at: '2026-10-03T00:00:00.000Z',
          rating: null,
        });
      }
      if (url.startsWith('/outfits')) {
        return respond(config, { outfits: [{ id: 'outfit-1', latestGeneration: { status: 'Pending' } }] });
      }
      return respond(config, null);
    };
    const previousAdapter = AXIOS_INSTANCE.defaults.adapter;
    AXIOS_INSTANCE.defaults.adapter = adapter;

    const statusCalls = () => calls.filter((url) => url.startsWith('/vto/generations/')).length;
    const outfitCalls = () => calls.filter((url) => url.startsWith('/outfits')).length;

    try {
      render(<App />);
      await act(async () => {
        await flushMicrotasks();
      });
      // Let the auth bootstrap, the generation start and the first reads settle.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
        await flushMicrotasks();
      });

      expect(screen.getByText('polling dashboard stub')).toBeInTheDocument();
      expect(statusCalls()).toBe(1);
      expect(outfitCalls()).toBe(1);

      // The first interval fires with the app intact: both reads repeat.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
        await flushMicrotasks();
      });
      expect(statusCalls()).toBe(2);
      expect(outfitCalls()).toBe(2);
      expect(screen.getByText('polling dashboard stub')).toBeInTheDocument();

      // The next fire is refused, which is what proves the observers were live.
      refusing = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
        await flushMicrotasks();
      });
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.queryByText('polling dashboard stub')).toBeNull();

      // Nothing schedules after the latch, for the rest of the document.
      const afterLatch = calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
        await flushMicrotasks();
      });
      expect(calls.length).toBe(afterLatch);
    } finally {
      AXIOS_INSTANCE.defaults.adapter = previousAdapter;
    }
  });
});

describe('the wardrobe list a query created after the cancel', () => {
  it('issues its one queued trailing read exactly once, not four times', async () => {
    vi.useFakeTimers();
    window.history.pushState({}, '', '/wardrobe');

    const wardrobeCalls: string[] = [];
    let releaseFirst!: () => void;
    const adapter: AxiosAdapter = async (config) => {
      const url = config.url ?? '';
      if (url === '/users/me') return respond(config, { id: 'user-1' });
      if (url === '/wardrobe') {
        wardrobeCalls.push(url);
        if (wardrobeCalls.length === 1) {
          // The mount read is still on the wire when the refusal lands.
          return new Promise<AxiosResponse>((_resolve, reject) => {
            releaseFirst = () => reject(axiosBadRequest(config, refusalBody(9, 8)));
          });
        }
        // The queued read is issued after the unmount, so the interceptor's
        // `cancelQueries()` — run by the mount read's refusal — cannot reach this
        // retryer. A second refusal here would cancel it again and hide the retry
        // predicate, so the trailing read fails with a retryable 500 instead: the
        // client default would retry it three times, and only the store-aware
        // predicate refuses them.
        throw axiosServerError(config);
      }
      return respond(config, null);
    };
    const previousAdapter = AXIOS_INSTANCE.defaults.adapter;
    AXIOS_INSTANCE.defaults.adapter = adapter;

    try {
      render(<App />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
        await flushMicrotasks();
      });
      expect(screen.getByText('wardrobe list stub')).toBeInTheDocument();
      expect(wardrobeCalls).toHaveLength(1);

      // The first recovery trigger joins the in-flight read; the second, landing
      // while that run is still in flight, queues exactly one trailing read.
      act(() => {
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('focus'));
      });

      // The refusal lands, the shell is replaced, and the queued read is issued
      // after the observers it belonged to are gone.
      await act(async () => {
        releaseFirst();
        await flushMicrotasks();
      });
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(wardrobeCalls).toHaveLength(2);

      // 8000ms covers query-core's whole default ladder for this read —
      // 1000, 2000 and 4000 ms — so an unguarded default has made all four
      // attempts by now. The store-aware predicate leaves exactly one.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000);
        await flushMicrotasks();
      });
      expect(wardrobeCalls.slice(1)).toHaveLength(1);
    } finally {
      AXIOS_INSTANCE.defaults.adapter = previousAdapter;
    }
  });
});
