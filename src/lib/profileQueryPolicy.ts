import type { QueryClient } from '@tanstack/react-query';
import { getHttpStatus } from './errors';
import { retryUnlessClientVersionRefused } from './queryRetryPolicy';

/** The generated profile hook's query key (`src/api/endpoints/users/users.ts`). */
export const PROFILE_QUERY_KEY = ['/users/me'] as const;

/**
 * Retries for the shared profile read. A 404 keeps the Service's dev fallback
 * time (two retries); any other non-authentication failure gets one; a 401 is
 * terminal because the Axios interceptor signs the user out and redirects.
 * Unknown errors count as other failures. The shared store-aware predicate is
 * composed first, because this key-scoped policy replaces the client default
 * rather than merging with it.
 */
export function retryProfileQuery(failureCount: number, error: unknown): boolean {
  if (!retryUnlessClientVersionRefused(failureCount)) return false;
  const status = getHttpStatus(error);
  if (status === 401) return false;
  if (status === 404) return failureCount < 2;
  return failureCount < 1;
}

/**
 * Register the policy once on the shared query key, so every consumer of
 * `useGetUsersMe` inherits it without restating retry rules per call site.
 */
export function registerProfileQueryPolicy(queryClient: QueryClient): void {
  queryClient.setQueryDefaults(PROFILE_QUERY_KEY, { retry: retryProfileQuery });
}
