import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

import {
  PROFILE_QUERY_KEY,
  registerProfileQueryPolicy,
  retryProfileQuery,
} from './profileQueryPolicy';

describe('retryProfileQuery', () => {
  it('keeps two retries for a 404, then stops', () => {
    const error = { response: { status: 404 } };

    expect(retryProfileQuery(0, error)).toBe(true);
    expect(retryProfileQuery(1, error)).toBe(true);
    expect(retryProfileQuery(2, error)).toBe(false);
    expect(retryProfileQuery(3, error)).toBe(false);
  });

  it('keeps one retry for another non-authentication failure, then stops', () => {
    const error = { response: { status: 500 } };

    expect(retryProfileQuery(0, error)).toBe(true);
    expect(retryProfileQuery(1, error)).toBe(false);
  });

  it('retries an unknown error as another failure', () => {
    const error = new Error('network down');

    expect(retryProfileQuery(0, error)).toBe(true);
    expect(retryProfileQuery(1, error)).toBe(false);
  });

  it('never retries a 401', () => {
    const error = { response: { status: 401 } };

    expect(retryProfileQuery(0, error)).toBe(false);
  });
});

describe('registerProfileQueryPolicy', () => {
  it('registers the function on the exact profile query key', () => {
    const queryClient = new QueryClient();

    registerProfileQueryPolicy(queryClient);

    // The generated hook's key (`getGetUsersMeQueryKey()`) is `['/users/me']`.
    expect(PROFILE_QUERY_KEY).toEqual(['/users/me']);
    expect(queryClient.getQueryDefaults(['/users/me']).retry).toBe(retryProfileQuery);
  });
});
