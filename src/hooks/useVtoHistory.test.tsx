// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

vi.mock('../api/endpoints/vto/vto', () => ({
  useGetVtoGenerations: vi.fn(),
  useDeleteVtoGenerationsGenerationId: vi.fn(),
}));

vi.mock('./useVtoRating', () => ({ default: vi.fn() }));

import { useGetVtoGenerations, useDeleteVtoGenerationsGenerationId } from '../api/endpoints/vto/vto';
import useVtoRating from './useVtoRating';
import useVtoHistory from './useVtoHistory';

interface MutationOptions {
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
}

const mutate = vi.fn<(variables: { generationId: string }, options: MutationOptions) => void>();
const refetch = vi.fn();

/** An Axios rejection: the status and the body live on `error.response`. */
function rejection(status: number, data?: unknown) {
  return { isAxiosError: true, response: { status, data } };
}

/** The generation delete's `502 OBJECT_DELETION_INCOMPLETE` body. */
function incompleteBody(details: unknown) {
  return {
    error: 'OBJECT_DELETION_INCOMPLETE',
    message: 'The resource was deleted, but stored objects could not be proven deleted',
    details,
  };
}

function lastOptions(): MutationOptions {
  const call = mutate.mock.calls[mutate.mock.calls.length - 1];
  if (!call) throw new Error('The delete mutation was never called');
  return call[1];
}

describe('useVtoHistory generation delete', () => {
  beforeEach(() => {
    mutate.mockReset();
    refetch.mockReset();
    vi.mocked(useGetVtoGenerations).mockReturnValue({
      data: undefined,
      isLoading: false,
      refetch,
    } as unknown as ReturnType<typeof useGetVtoGenerations>);
    vi.mocked(useDeleteVtoGenerationsGenerationId).mockReturnValue({
      mutate,
    } as unknown as ReturnType<typeof useDeleteVtoGenerationsGenerationId>);
    vi.mocked(useVtoRating).mockReturnValue({
      save: vi.fn(),
      failures: {},
      echoResetTokens: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('reports the count and re-reads the list for a 502 incomplete delete', () => {
    const { result } = renderHook(() => useVtoHistory());

    act(() => result.current.deleteGeneration('gen-1'));
    expect(result.current.deleteRetainedKeyCount).toBeNull();
    expect(mutate).toHaveBeenCalledWith({ generationId: 'gen-1' }, expect.anything());

    act(() => lastOptions().onError?.(rejection(502, incompleteBody({ manifest_id: '5f0c', retained_key_count: 3 }))));

    expect(result.current.deleteRetainedKeyCount).toBe(3);
    // The rows are committed as deleted, so the stale row leaves with the read.
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('clears the reported count when a new delete attempt starts', () => {
    const { result } = renderHook(() => useVtoHistory());

    act(() => result.current.deleteGeneration('gen-1'));
    act(() => lastOptions().onError?.(rejection(502, incompleteBody({ manifest_id: '5f0c', retained_key_count: 2 }))));
    expect(result.current.deleteRetainedKeyCount).toBe(2);

    act(() => result.current.deleteGeneration('gen-2'));
    expect(result.current.deleteRetainedKeyCount).toBeNull();

    act(() => lastOptions().onSuccess?.());
    expect(result.current.deleteRetainedKeyCount).toBeNull();
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it.each<[string, unknown]>([
    [
      'a 502 whose body carries no count',
      rejection(502, incompleteBody({ manifest_id: '5f0c' })),
    ],
    [
      'a 502 whose body still carries the outfit-shaped key list',
      rejection(502, incompleteBody({
        manifest_id: '5f0c',
        retained_object_keys: ['outfit-generations/u/o/g/execution-1.png'],
      })),
    ],
    [
      'a 502 with a zero count',
      rejection(502, incompleteBody({ manifest_id: '5f0c', retained_key_count: 0 })),
    ],
    [
      'a non-502 carrying the incomplete-delete body',
      rejection(500, incompleteBody({ manifest_id: '5f0c', retained_key_count: 3 })),
    ],
    ['a transport failure', new Error('Network Error')],
  ])('reports nothing and re-reads nothing for %s', (_label, error) => {
    const { result } = renderHook(() => useVtoHistory());

    act(() => result.current.deleteGeneration('gen-1'));
    act(() => lastOptions().onError?.(error));

    expect(result.current.deleteRetainedKeyCount).toBeNull();
    expect(refetch).not.toHaveBeenCalled();
  });

  it('still re-reads the list after a successful delete', () => {
    const { result } = renderHook(() => useVtoHistory());

    act(() => result.current.deleteGeneration('gen-1'));
    act(() => lastOptions().onSuccess?.());

    expect(result.current.deleteRetainedKeyCount).toBeNull();
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
