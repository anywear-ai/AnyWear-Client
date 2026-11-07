import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetVtoGenerationsGenerationIdQueryKey,
  usePatchVtoGenerationsGenerationIdRating,
} from '../api/endpoints/vto/vto';
import type { VtoStatusResponse } from '../api/model/vtoStatusResponse';
import { getHttpStatus } from '../lib/errors';

const SAVE_FAILURE = "Couldn't save your rating. Choose a star to try again.";
const NOT_FOUND_FAILURE = 'This try-on no longer exists, so your rating was not saved.';

export interface VtoRating {
  /** Saves one rating; a null generation id sends nothing. */
  save: (generationId: string | null, rating: number) => void;
  /** The failure sentence recorded for a generation, keyed by its id. */
  failures: Record<string, string>;
  /** A per-generation number that changes whenever a save settles. */
  echoResetTokens: Record<string, number>;
}

/**
 * The single owner of the generated rating write.
 *
 * The rating write does not bump `state_version`, so the status read cannot
 * announce the change by version. On a 200 the acknowledged value is written
 * into the generation's cached status and the echo is reset only when a status
 * read for that generation is mounted (the result area is displaying it); a
 * history card has no such read, so its echo is left for the list refetch to
 * clear. Both reads are invalidated in either case so the API stays the
 * authority. Only the latest attempt for a generation may change state.
 */
export default function useVtoRating(): VtoRating {
  const queryClient = useQueryClient();
  const rateMutation = usePatchVtoGenerationsGenerationIdRating();
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [echoResetTokens, setEchoResetTokens] = useState<Record<string, number>>({});
  const attempts = useRef<Record<string, number>>({});

  const save = useCallback((generationId: string | null, rating: number) => {
    if (!generationId) return;
    const id = generationId;
    const attempt = (attempts.current[id] ?? 0) + 1;
    attempts.current[id] = attempt;
    const isLatest = () => attempts.current[id] === attempt;

    void (async () => {
      try {
        await rateMutation.mutateAsync({ generationId: id, data: { rating } });
        // A superseded settlement has no effect at all: no cache write, no
        // token bump, no failure record and no invalidation.
        if (!isLatest()) return;

        const statusKey = getGetVtoGenerationsGenerationIdQueryKey(id);
        // The mounted-status rule: `getQueryData` is defined only while a read
        // of this generation is cached, which is the case when the result area
        // displays it. Without that read there is nothing to acknowledge into.
        const cached = queryClient.getQueryData<VtoStatusResponse>(statusKey);
        if (cached !== undefined) {
          queryClient.setQueryData<VtoStatusResponse>(statusKey, { ...cached, rating });
          setEchoResetTokens((tokens) => ({ ...tokens, [id]: (tokens[id] ?? 0) + 1 }));
        }
        setFailures((current) => {
          if (!(id in current)) return current;
          const next = { ...current };
          delete next[id];
          return next;
        });

        queryClient.invalidateQueries({ queryKey: statusKey });
        queryClient.invalidateQueries({ queryKey: ['/vto/generations'] });
      } catch (error) {
        if (!isLatest()) return;
        setFailures((current) => ({
          ...current,
          [id]: getHttpStatus(error) === 404 ? NOT_FOUND_FAILURE : SAVE_FAILURE,
        }));
        setEchoResetTokens((tokens) => ({ ...tokens, [id]: (tokens[id] ?? 0) + 1 }));
      }
    })();
  }, [queryClient, rateMutation]);

  return { save, failures, echoResetTokens };
}
