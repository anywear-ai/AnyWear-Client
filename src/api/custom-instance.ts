import Axios, { AxiosError, AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';
import { fetchAuthSession } from 'aws-amplify/auth';
import { CLIENT_VERSION, CLIENT_VERSION_HEADER } from '../lib/client-version';
import { getClientVersionRefusal } from '../lib/client-version-refusal';
import { queryClient } from '../lib/queryClient';
import { useAuthStore } from '../store/authStore';
import { isClientVersionRefused, useClientVersionRefusalStore } from '../store/clientVersionRefusalStore';

export const AXIOS_INSTANCE = Axios.create({ baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000' });

interface RetriableRequestConfig extends InternalAxiosRequestConfig {
  anywearNetworkRetry?: boolean;
}

function isAsyncTaskCreationRequest(config: InternalAxiosRequestConfig): boolean {
  if (config.method?.toUpperCase() !== 'POST' || !config.url) return false;
  const path = new URL(config.url, 'http://anywear.local').pathname;
  return path === '/vto/generations'
    || path === '/wardrobe/upload'
    || /^\/wardrobe\/items\/[^/]+\/retag$/.test(path);
}

function hasIdempotencyKey(config: InternalAxiosRequestConfig): boolean {
  return typeof config.headers.get('Idempotency-Key') === 'string';
}

AXIOS_INSTANCE.interceptors.request.use(
  async (config) => {
    // Every request states the Client version, authenticated or not, so the
    // Service can reject an incompatible Client before it does any work.
    config.headers.set(CLIENT_VERSION_HEADER, String(CLIENT_VERSION));
    if (isAsyncTaskCreationRequest(config) && !hasIdempotencyKey(config)) {
      config.headers.set('Idempotency-Key', crypto.randomUUID());
    }
    try {
      const session = await fetchAuthSession();
      const token = session.tokens?.accessToken?.toString();
      if (token && config.headers) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    } catch (error) {
      console.debug('No active auth session', error);
    }
    return config;
  },
  (error) => Promise.reject(error)
);

AXIOS_INSTANCE.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    // A terminal refusal is a fact about the build, not this request's failure,
    // so it is recognised before the 401 branch and before the network retry.
    // The original error is rejected unchanged: `batchUpload` treats a missing
    // status as transient, so a wrapper would make the batch upload retry the
    // refusal. The cancel runs in the same synchronous block as the latch.
    const refusal = getClientVersionRefusal(error);
    if (refusal) {
      useClientVersionRefusalStore.getState().recordRefusal(refusal);
      void queryClient.cancelQueries();
      return Promise.reject(error);
    }

    // A 401 arriving after the refusal must not sign out or navigate to a login
    // page that calls no Service route: that redirect is a full document load,
    // which would clear the refusal and swap the blocking screen for a page one
    // sign-in away from the same refusal.
    if (error.response?.status === 401 && !isClientVersionRefused()) {
      const currentPath = window.location.pathname;
      if (currentPath !== '/login' && currentPath !== '/register') {
        // logout() destroys the persisted session even when the SDK sign-out rejects and records
        // that failure in the store; this interceptor still forces the redirect.
        await useAuthStore.getState().logout().catch(() => undefined);
        window.location.href = '/login';
      }
    }
    const config = error.config as RetriableRequestConfig | undefined;
    if (
      !error.response
      && config
      && hasIdempotencyKey(config)
      && !config.anywearNetworkRetry
      && !Axios.isCancel(error)
    ) {
      config.anywearNetworkRetry = true;
      return AXIOS_INSTANCE.request(config);
    }
    return Promise.reject(error);
  }
);

export const customInstance = <T>(
  config: AxiosRequestConfig,
  options?: AxiosRequestConfig,
): Promise<T> => {
  const source = Axios.CancelToken.source();
  const promise = AXIOS_INSTANCE({
    ...config,
    ...options,
    cancelToken: source.token,
  }).then((response) => response.data as unknown as T);

  // @ts-expect-error cancel property on promise
  promise.cancel = () => {
    source.cancel('Query was cancelled');
  };

  return promise;
};
