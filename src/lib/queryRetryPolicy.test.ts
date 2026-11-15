import { beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from './queryClient';
import { DEFAULT_QUERY_RETRY_LIMIT, retryUnlessClientVersionRefused } from './queryRetryPolicy';
import { PROFILE_QUERY_KEY } from './profileQueryPolicy';
import { useClientVersionRefusalStore } from '../store/clientVersionRefusalStore';

const REFUSAL = {
  minimumClientVersion: 9,
  receivedClientVersion: 8,
  detailsReported: true,
} as const;

function latch(): void {
  useClientVersionRefusalStore.getState().recordRefusal(REFUSAL);
}

/** Counts attempts; `retryDelay: 0` keeps the preserved default fast to observe. */
async function attemptsFor(fetchOptions: { queryKey: readonly unknown[]; status: number }): Promise<number> {
  const error = Object.assign(new Error('failed'), {
    response: { status: fetchOptions.status },
  });
  const queryFn = vi.fn().mockRejectedValue(error);
  await expect(queryClient.fetchQuery({
    queryKey: fetchOptions.queryKey,
    queryFn,
    retryDelay: 0,
  })).rejects.toBe(error);
  return queryFn.mock.calls.length;
}

describe('retryUnlessClientVersionRefused', () => {
  beforeEach(() => {
    useClientVersionRefusalStore.setState({ refusal: null });
    queryClient.clear();
  });

  it('reproduces the client default of three retries while nothing is refused', () => {
    expect(DEFAULT_QUERY_RETRY_LIMIT).toBe(3);
    expect(retryUnlessClientVersionRefused(0)).toBe(true);
    expect(retryUnlessClientVersionRefused(1)).toBe(true);
    expect(retryUnlessClientVersionRefused(2)).toBe(true);
    expect(retryUnlessClientVersionRefused(3)).toBe(false);
  });

  it('refuses every retry once the refusal is latched', () => {
    latch();

    expect(retryUnlessClientVersionRefused(0)).toBe(false);
    expect(retryUnlessClientVersionRefused(1)).toBe(false);
  });
});

describe('the shared query client retry policy', () => {
  beforeEach(() => {
    useClientVersionRefusalStore.setState({ refusal: null });
    queryClient.clear();
  });

  it('keeps the three-retry default for a query created while nothing is refused', async () => {
    expect(await attemptsFor({ queryKey: ['/wardrobe', 'unrefused'], status: 500 })).toBe(4);
  });

  it('gives a query created after the latch exactly one attempt', async () => {
    latch();

    expect(await attemptsFor({ queryKey: ['/wardrobe', 'refused'], status: 400 })).toBe(1);
  });

  it('covers the profile read, whose key-scoped policy would otherwise grant its own retry', async () => {
    latch();

    expect(await attemptsFor({ queryKey: PROFILE_QUERY_KEY, status: 404 })).toBe(1);
  });
});
