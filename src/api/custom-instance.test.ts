import type { AxiosAdapter, AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAuthSession, signOut } from 'aws-amplify/auth';
import Axios from 'axios';
import { isCancelledError } from '@tanstack/react-query';
import { AXIOS_INSTANCE, customInstance } from './custom-instance';
import { useAuthStore } from '../store/authStore';
import { useClientVersionRefusalStore } from '../store/clientVersionRefusalStore';
import { queryClient } from '../lib/queryClient';
import { CLIENT_VERSION } from '../lib/client-version';

vi.mock('aws-amplify/auth', () => ({ fetchAuthSession: vi.fn(), signOut: vi.fn() }));

/** The Service's real refusal body (ADR-0026 §2). */
const REFUSAL_BODY = {
  error: 'CLIENT_VERSION_UNSUPPORTED',
  details: { minimum_client_version: 9, received_client_version: 8 },
};

const PARSED_REFUSAL = {
  minimumClientVersion: 9,
  receivedClientVersion: 8,
  detailsReported: true,
};

beforeEach(() => {
  useClientVersionRefusalStore.setState({ refusal: null });
  queryClient.clear();
});

function axiosFailure(
  config: InternalAxiosRequestConfig,
  status: number,
  data: unknown,
): AxiosError {
  return new Axios.AxiosError('Request failed', 'ERR_BAD_REQUEST', config, undefined, {
    data,
    status,
    statusText: 'Error',
    headers: {},
    config,
  } as AxiosResponse);
}

interface RefusedRequest {
  /** The error the caller observed, for identity assertions. */
  observed: unknown;
  /** The error the adapter threw. */
  thrown: unknown;
  /** How many times the adapter ran. */
  calls: number;
}

function response(config: InternalAxiosRequestConfig): AxiosResponse<{ ok: true }> {
  return {
    data: { ok: true },
    status: 202,
    statusText: 'Accepted',
    headers: {},
    config,
  };
}

describe('customInstance idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchAuthSession).mockResolvedValue({} as Awaited<ReturnType<typeof fetchAuthSession>>);
  });

  it('reuses one key and the Client version header for an automatic network retry', async () => {
    const keys: string[] = [];
    const versions: unknown[] = [];
    const adapter: AxiosAdapter = async (config) => {
      keys.push(String(config.headers.get('Idempotency-Key')));
      versions.push(config.headers.get('X-AnyWear-Client-Version'));
      if (keys.length === 1) {
        throw new Axios.AxiosError('connection reset', 'ERR_NETWORK', config);
      }
      return response(config);
    };

    await expect(customInstance<{ ok: true }>({
      url: '/vto/generations',
      method: 'POST',
      data: { outfit_id: 'outfit-1' },
    }, { adapter })).resolves.toEqual({ ok: true });

    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(versions).toEqual([String(CLIENT_VERSION), String(CLIENT_VERSION)]);
  });

  it('sends the Client version header even when no auth session exists', async () => {
    vi.clearAllMocks();
    vi.mocked(fetchAuthSession).mockRejectedValue(new Error('No current user'));
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    let version: unknown;
    let authorization: unknown;
    const adapter: AxiosAdapter = async (config) => {
      version = config.headers.get('X-AnyWear-Client-Version');
      authorization = config.headers.get('Authorization');
      return response(config);
    };

    try {
      await customInstance({ url: '/users/me', method: 'GET' }, { adapter });
    } finally {
      debug.mockRestore();
    }

    expect(fetchAuthSession).toHaveBeenCalledTimes(1);
    expect(version).toBe(String(CLIENT_VERSION));
    expect(authorization).toBeUndefined();
  });

  it('creates a new key for each new logical operation', async () => {
    const keys: string[] = [];
    const adapter: AxiosAdapter = async (config) => {
      keys.push(String(config.headers.get('Idempotency-Key')));
      return response(config);
    };

    await customInstance({ url: '/wardrobe/upload', method: 'POST' }, { adapter });
    await customInstance({ url: '/wardrobe/upload', method: 'POST' }, { adapter });

    expect(keys[0]).not.toBe(keys[1]);
  });

  it('does not add a key to unrelated requests', async () => {
    let key: unknown;
    const adapter: AxiosAdapter = async (config) => {
      key = config.headers.get('Idempotency-Key');
      return response(config);
    };

    await customInstance({ url: '/wardrobe', method: 'GET' }, { adapter });

    expect(key).toBeUndefined();
  });
});

describe('customInstance authentication', () => {
  const persistedSessionKey = 'CognitoIdentityServiceProvider.mock-client-id.test-user.accessToken';

  it('finishes SDK sign-out before a 401 forces navigation', async () => {
    vi.clearAllMocks();
    vi.mocked(fetchAuthSession).mockResolvedValue({});
    let finishSignOut!: () => void;
    vi.mocked(signOut).mockReturnValue(new Promise<void>(resolve => { finishSignOut = resolve; }));
    const location = { pathname: '/wardrobe', href: '' };
    vi.stubGlobal('window', { location });
    useAuthStore.getState().setAuthenticated(true);
    localStorage.setItem(persistedSessionKey, 'access-token');
    const adapter: AxiosAdapter = async (config) => {
      throw new Axios.AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, {
        ...response(config), status: 401,
      });
    };
    try {
      const request = customInstance({ url: '/users/me', method: 'GET' }, { adapter });
      const rejection = expect(request).rejects.toThrow('Unauthorized');
      await vi.waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
      // The session is only reported as gone once the persisted tokens are gone and navigation runs.
      expect(useAuthStore.getState().isSigningOut).toBe(true);
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(localStorage.getItem(persistedSessionKey)).toBe('access-token');
      expect(location.href).toBe('');
      finishSignOut();
      await rejection;
      expect(localStorage.getItem(persistedSessionKey)).toBeNull();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
      expect(location.href).toBe('/login');
    } finally {
      vi.unstubAllGlobals();
      localStorage.clear();
    }
  });

  it('clears the persisted session and still navigates when the 401 sign-out rejects', async () => {
    vi.clearAllMocks();
    vi.mocked(fetchAuthSession).mockResolvedValue({});
    vi.mocked(signOut).mockRejectedValue(new Error('SDK sign-out failed'));
    const location = { pathname: '/wardrobe', href: '' };
    vi.stubGlobal('window', { location });
    useAuthStore.getState().setAuthenticated(true);
    localStorage.setItem(persistedSessionKey, 'access-token');
    const adapter: AxiosAdapter = async (config) => {
      throw new Axios.AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, {
        ...response(config), status: 401,
      });
    };
    try {
      await expect(customInstance({ url: '/users/me', method: 'GET' }, { adapter }))
        .rejects.toThrow('Unauthorized');
      expect(signOut).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(persistedSessionKey)).toBeNull();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
      expect(useAuthStore.getState().logoutError).toBe('SDK sign-out failed');
      expect(location.href).toBe('/login');
    } finally {
      vi.unstubAllGlobals();
      localStorage.clear();
      useAuthStore.setState({ isAuthenticated: false, isSigningOut: false, logoutError: null });
    }
  });

  it('resolves the current SDK token for every request instead of caching it', async () => {
    vi.clearAllMocks();
    const session = (token: string) => ({
      tokens: { accessToken: { toString: () => token } },
    }) as Awaited<ReturnType<typeof fetchAuthSession>>;
    vi.mocked(fetchAuthSession)
      .mockResolvedValueOnce(session('first-token'))
      .mockResolvedValueOnce(session('refreshed-token'));
    const headers: unknown[] = [];
    const adapter: AxiosAdapter = async (config) => {
      headers.push(config.headers.get('Authorization'));
      return response(config);
    };
    await customInstance({ url: '/users/me', method: 'GET' }, { adapter });
    await customInstance({ url: '/wardrobe', method: 'GET' }, { adapter });
    expect(fetchAuthSession).toHaveBeenCalledTimes(2);
    expect(headers).toEqual(['Bearer first-token', 'Bearer refreshed-token']);
  });
});

/** Lets every pending microtask run without advancing a timer. */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

/**
 * Drives one request through an adapter that answers with `body`, and returns
 * what the caller observed. `onReject` runs inside the caller's rejection
 * handler, which is where the "same tick" bound is asserted.
 */
async function driveRefused(
  request: (adapter: AxiosAdapter) => Promise<unknown>,
  body: unknown = REFUSAL_BODY,
  onReject?: (error: unknown) => void,
): Promise<RefusedRequest> {
  let thrown: unknown;
  let calls = 0;
  const adapter: AxiosAdapter = async (config) => {
    calls += 1;
    thrown = axiosFailure(config, 400, body);
    throw thrown;
  };
  const observed = await request(adapter).then(
    () => undefined,
    (error: unknown) => {
      onReject?.(error);
      return error;
    },
  );
  return { observed, thrown, calls };
}

describe('customInstance client-version refusal recognition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchAuthSession).mockResolvedValue({} as Awaited<ReturnType<typeof fetchAuthSession>>);
  });

  it('records the refusal once from a wardrobe read, a profile read and a direct image-upload post', async () => {
    const shapes: Array<[string, (adapter: AxiosAdapter) => Promise<unknown>]> = [
      ['a wardrobe read', (adapter) => customInstance({ url: '/wardrobe', method: 'GET' }, { adapter })],
      ['a profile read', (adapter) => customInstance({ url: '/users/me', method: 'GET' }, { adapter })],
      ['a direct image-upload post', (adapter) => AXIOS_INSTANCE.post(
        '/wardrobe/items/item-1/upload-url',
        { contentType: 'image/jpeg' },
        { adapter },
      )],
    ];

    for (const [label, request] of shapes) {
      useClientVersionRefusalStore.setState({ refusal: null });
      const refused = await driveRefused(request, REFUSAL_BODY, () => {
        // The latch is already written in the same tick the rejection is observed.
        expect(useClientVersionRefusalStore.getState().refusal, label).toEqual(PARSED_REFUSAL);
      });
      expect(refused.calls, label).toBe(1);
      expect(refused.observed, label).toBe(refused.thrown);
      expect(refused.observed, label).toBeInstanceOf(Axios.AxiosError);
      expect(useClientVersionRefusalStore.getState().refusal, label).toEqual(PARSED_REFUSAL);
    }
  });

  it('latches a refusal whose details is absent and one whose details is malformed', async () => {
    for (const body of [
      { error: 'CLIENT_VERSION_UNSUPPORTED' },
      { error: 'CLIENT_VERSION_UNSUPPORTED', details: { minimum_client_version: 'nine' } },
    ]) {
      useClientVersionRefusalStore.setState({ refusal: null });
      const refused = await driveRefused(
        (adapter) => customInstance({ url: '/wardrobe', method: 'GET' }, { adapter }),
        body,
      );
      expect(refused.observed).toBe(refused.thrown);
      expect(useClientVersionRefusalStore.getState().refusal).not.toBeNull();
      expect(useClientVersionRefusalStore.getState().refusal?.minimumClientVersion).toBeNull();
    }
  });

  it('leaves the latch empty for every other answer', async () => {
    const answers: Array<[string, number, unknown]> = [
      ['a VALIDATION_ERROR 400', 400, { error: 'VALIDATION_ERROR', message: 'Name is required' }],
      ['a 400 whose body is not JSON', 400, 'not JSON'],
      ['a 400 with no body', 400, undefined],
      ['a 403', 403, { error: 'FORBIDDEN' }],
      ['a 404', 404, { error: 'NOT_FOUND' }],
      ['a 409', 409, { error: 'CONFLICT' }],
    ];

    for (const [label, status, body] of answers) {
      const adapter: AxiosAdapter = async (config) => {
        throw axiosFailure(config, status, body);
      };
      await expect(
        customInstance({ url: '/wardrobe', method: 'GET' }, { adapter }),
        label,
      ).rejects.toBeInstanceOf(Axios.AxiosError);
      expect(useClientVersionRefusalStore.getState().refusal, label).toBeNull();
    }
  });

  it('leaves the latch empty for a network failure with no response', async () => {
    const adapter: AxiosAdapter = async (config) => {
      throw new Axios.AxiosError('connection reset', 'ERR_NETWORK', config);
    };

    await expect(customInstance({ url: '/wardrobe', method: 'GET' }, { adapter }))
      .rejects.toBeInstanceOf(Axios.AxiosError);
    expect(useClientVersionRefusalStore.getState().refusal).toBeNull();
  });

  it('leaves the latch empty for a 401 and still runs the existing handling', async () => {
    vi.mocked(signOut).mockResolvedValue();
    const location = { pathname: '/wardrobe', href: '' };
    vi.stubGlobal('window', { location });
    const adapter: AxiosAdapter = async (config) => {
      throw axiosFailure(config, 401, { error: 'UNAUTHORIZED' });
    };
    try {
      await expect(customInstance({ url: '/users/me', method: 'GET' }, { adapter }))
        .rejects.toBeInstanceOf(Axios.AxiosError);
      expect(useClientVersionRefusalStore.getState().refusal).toBeNull();
      expect(signOut).toHaveBeenCalledTimes(1);
      expect(location.href).toBe('/login');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the first refusal when a second arrives with different versions', async () => {
    await driveRefused((adapter) => customInstance({ url: '/wardrobe', method: 'GET' }, { adapter }));
    const second = await driveRefused(
      (adapter) => customInstance({ url: '/wardrobe', method: 'GET' }, { adapter }),
      { error: 'CLIENT_VERSION_UNSUPPORTED', details: { minimum_client_version: 10, received_client_version: 9 } },
    );

    expect(second.calls).toBe(1);
    expect(useClientVersionRefusalStore.getState().refusal).toEqual(PARSED_REFUSAL);
  });
});

describe('the 401 branch around a latched refusal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchAuthSession).mockResolvedValue({} as Awaited<ReturnType<typeof fetchAuthSession>>);
    vi.mocked(signOut).mockResolvedValue();
  });

  /** Drives a 401 at `pathname` and returns the location stub it ran against. */
  async function drive401(pathname: string): Promise<{ pathname: string; href: string }> {
    const location = { pathname, href: '' };
    vi.stubGlobal('window', { location });
    const adapter: AxiosAdapter = async (config) => {
      throw axiosFailure(config, 401, { error: 'UNAUTHORIZED' });
    };
    await expect(customInstance({ url: '/users/me', method: 'GET' }, { adapter }))
      .rejects.toBeInstanceOf(Axios.AxiosError);
    return location;
  }

  it('signs out and navigates at /wardrobe while nothing is refused', async () => {
    try {
      const location = await drive401('/wardrobe');

      expect(signOut).toHaveBeenCalledTimes(1);
      expect(location.href).toBe('/login');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does neither at /wardrobe once the refusal is latched', async () => {
    useClientVersionRefusalStore.setState({ refusal: PARSED_REFUSAL });
    try {
      const location = await drive401('/wardrobe');

      expect(signOut).not.toHaveBeenCalled();
      expect(location.href).toBe('');
      expect(useClientVersionRefusalStore.getState().refusal).toEqual(PARSED_REFUSAL);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does neither at /login while nothing is refused', async () => {
    try {
      const location = await drive401('/login');

      expect(signOut).not.toHaveBeenCalled();
      expect(location.href).toBe('');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does neither at /login once the refusal is latched', async () => {
    useClientVersionRefusalStore.setState({ refusal: PARSED_REFUSAL });
    try {
      const location = await drive401('/login');

      expect(signOut).not.toHaveBeenCalled();
      expect(location.href).toBe('');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the refusal cancels what is in flight', () => {
  it('cancels an already-fetching query and schedules nothing after it', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchAuthSession).mockResolvedValue({} as Awaited<ReturnType<typeof fetchAuthSession>>);
    try {
      const queryKey = ['/wardrobe', 'in-flight'] as const;
      let adapterCalls = 0;
      let release!: () => void;
      const pendingAdapter: AxiosAdapter = (config) => {
        adapterCalls += 1;
        return new Promise<AxiosResponse>((resolve) => {
          release = () => resolve(response(config));
        });
      };
      const pending = queryClient.fetchQuery({
        queryKey,
        queryFn: () => customInstance({ url: '/wardrobe', method: 'GET' }, { adapter: pendingAdapter }),
        retryDelay: 0,
      });
      await flushMicrotasks();
      expect(adapterCalls).toBe(1);

      const refused = await driveRefused(
        (adapter) => customInstance({ url: '/wardrobe', method: 'GET' }, { adapter }),
      );
      expect(refused.calls).toBe(1);

      const outcome = await pending.then(() => undefined, (error: unknown) => error);
      expect(isCancelledError(outcome)).toBe(true);

      // The response this query asked for arrives, and is not applied.
      release();
      await flushMicrotasks();
      expect(queryClient.getQueryData(queryKey)).toBeUndefined();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(adapterCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
