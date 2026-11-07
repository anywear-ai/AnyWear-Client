import type { PropsWithChildren } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const patchRating = vi.hoisted(() => vi.fn());

// Keep the real query-key helper: the hook uses it to name the status read it
// acknowledges into.
vi.mock('../api/endpoints/vto/vto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/endpoints/vto/vto')>();
  return {
    ...actual,
    usePatchVtoGenerationsGenerationIdRating: () => ({ mutateAsync: patchRating }),
  };
});

import useVtoRating from './useVtoRating';
import { getGetVtoGenerationsGenerationIdQueryKey } from '../api/endpoints/vto/vto';
import type { VtoStatusResponse } from '../api/model/vtoStatusResponse';

const SAVE_FAILURE = "Couldn't save your rating. Choose a star to try again.";
const NOT_FOUND_FAILURE = 'This try-on no longer exists, so your rating was not saved.';

function status(overrides: Partial<VtoStatusResponse> = {}): VtoStatusResponse {
  return {
    generation_id: 'generation-1',
    status: 'Complete',
    state_version: 3,
    imageId: 'image-1',
    url: 'https://example.com/result.jpg',
    created_at: '2026-11-07T00:00:00.000Z',
    rating: null,
    ...overrides,
  };
}

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, ...renderHook(() => useVtoRating(), { wrapper }) };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

async function saveAndSettle(
  save: (generationId: string | null, rating: number) => void,
  generationId: string | null,
  rating: number,
) {
  act(() => {
    save(generationId, rating);
  });
  await settle();
}

describe('useVtoRating', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('writes the acknowledged rating into a mounted status read and invalidates both reads', async () => {
    const { queryClient, result } = setup();
    const statusKey = getGetVtoGenerationsGenerationIdQueryKey('generation-1');
    queryClient.setQueryData(statusKey, status({ rating: null }));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    patchRating.mockResolvedValueOnce(undefined);

    await saveAndSettle(result.current.save, 'generation-1', 4);

    expect(patchRating).toHaveBeenCalledWith({ generationId: 'generation-1', data: { rating: 4 } });
    expect(queryClient.getQueryData(statusKey)).toEqual(status({ rating: 4 }));
    expect(result.current.echoResetTokens['generation-1']).toBe(1);
    expect(result.current.failures).toEqual({});
    expect(invalidate).toHaveBeenCalledWith({ queryKey: statusKey });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['/vto/generations'] });
  });

  it('presents nothing as stored until the rating write settles', async () => {
    const { queryClient, result } = setup();
    const statusKey = getGetVtoGenerationsGenerationIdQueryKey('generation-1');
    queryClient.setQueryData(statusKey, status({ rating: null }));
    let resolveWrite!: () => void;
    patchRating.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveWrite = resolve; }),
    );

    act(() => {
      result.current.save('generation-1', 4);
    });

    // The deciding check for acceptance criterion 5: while the write is in
    // flight, nothing the surface reads has moved. A hook that wrote the
    // acknowledged rating into the cache before awaiting would fail here.
    expect(patchRating).toHaveBeenCalledTimes(1);
    expect(patchRating).toHaveBeenCalledWith({ generationId: 'generation-1', data: { rating: 4 } });
    expect(queryClient.getQueryData(statusKey)).toEqual(status({ rating: null }));
    expect(result.current.echoResetTokens['generation-1']).toBeUndefined();
    expect(result.current.failures).toEqual({});

    await act(async () => {
      resolveWrite();
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });

    expect(queryClient.getQueryData(statusKey)).toEqual(status({ rating: 4 }));
    expect(result.current.echoResetTokens['generation-1']).toBe(1);
  });

  it('writes and bumps nothing without a mounted status read, while still invalidating the history list', async () => {
    const { queryClient, result } = setup();
    const statusKey = getGetVtoGenerationsGenerationIdQueryKey('generation-1');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    patchRating.mockResolvedValueOnce(undefined);

    await saveAndSettle(result.current.save, 'generation-1', 4);

    expect(queryClient.getQueryData(statusKey)).toBeUndefined();
    expect(result.current.echoResetTokens).toEqual({});
    expect(result.current.failures).toEqual({});
    expect(invalidate).toHaveBeenCalledWith({ queryKey: statusKey });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['/vto/generations'] });
  });

  it('lets only the latest attempt settle, so an earlier response writes nothing', async () => {
    const { queryClient, result } = setup();
    const statusKey = getGetVtoGenerationsGenerationIdQueryKey('generation-1');
    queryClient.setQueryData(statusKey, status({ rating: null }));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    patchRating
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSecond = resolve; }));

    act(() => {
      result.current.save('generation-1', 2);
    });
    act(() => {
      result.current.save('generation-1', 5);
    });
    expect(patchRating).toHaveBeenCalledTimes(2);

    // The newer attempt settles first.
    await act(async () => {
      resolveSecond();
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    expect(queryClient.getQueryData(statusKey)).toEqual(status({ rating: 5 }));
    expect(result.current.echoResetTokens['generation-1']).toBe(1);
    expect(invalidate).toHaveBeenCalledTimes(2);

    // The older response arrives last and is ignored.
    await act(async () => {
      resolveFirst();
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    expect(queryClient.getQueryData(statusKey)).toEqual(status({ rating: 5 }));
    expect(result.current.echoResetTokens['generation-1']).toBe(1);
    expect(result.current.failures).toEqual({});
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('records the not-found sentence and resets the echo when the generation is gone', async () => {
    const { queryClient, result } = setup();
    const statusKey = getGetVtoGenerationsGenerationIdQueryKey('generation-1');
    queryClient.setQueryData(statusKey, status({ rating: null }));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    patchRating.mockRejectedValueOnce({ response: { status: 404 } });

    await saveAndSettle(result.current.save, 'generation-1', 4);

    expect(result.current.failures['generation-1']).toBe(NOT_FOUND_FAILURE);
    expect(result.current.echoResetTokens['generation-1']).toBe(1);
    expect(queryClient.getQueryData(statusKey)).toEqual(status({ rating: null }));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ['a 500 response', { response: { status: 500 } }],
    ['a network failure', new Error('Network Error')],
  ])('records the generic sentence for %s', async (_label, error) => {
    const { result } = setup();
    patchRating.mockRejectedValueOnce(error);

    await saveAndSettle(result.current.save, 'generation-1', 4);

    expect(result.current.failures['generation-1']).toBe(SAVE_FAILURE);
    expect(result.current.echoResetTokens['generation-1']).toBe(1);
  });

  it('sends nothing for a null generation id', async () => {
    const { result } = setup();

    await saveAndSettle(result.current.save, null, 4);

    expect(patchRating).not.toHaveBeenCalled();
    expect(result.current.failures).toEqual({});
    expect(result.current.echoResetTokens).toEqual({});
  });

  it('clears the failure and sends again when a second star is chosen after a failure', async () => {
    const { queryClient, result } = setup();
    const statusKey = getGetVtoGenerationsGenerationIdQueryKey('generation-1');
    queryClient.setQueryData(statusKey, status({ rating: null }));
    patchRating
      .mockRejectedValueOnce({ response: { status: 500 } })
      .mockResolvedValueOnce(undefined);

    await saveAndSettle(result.current.save, 'generation-1', 4);
    expect(result.current.failures['generation-1']).toBe(SAVE_FAILURE);

    await saveAndSettle(result.current.save, 'generation-1', 5);

    expect(patchRating).toHaveBeenCalledTimes(2);
    expect(patchRating).toHaveBeenLastCalledWith({ generationId: 'generation-1', data: { rating: 5 } });
    expect(result.current.failures['generation-1']).toBeUndefined();
    expect(queryClient.getQueryData(statusKey)).toEqual(status({ rating: 5 }));
  });
});
