import { isClientVersionRefused } from '../store/clientVersionRefusalStore';

/**
 * Today's client-default retry count: three retries after the first attempt,
 * which is what `new QueryClient()` grants when no `retry` is configured.
 * `@tanstack/query-core` reads a numeric `retry` as `failureCount < retry`, so
 * the predicate below reproduces that rule exactly while a refusal is absent.
 */
export const DEFAULT_QUERY_RETRY_LIMIT = 3;

/**
 * The one store-aware retry predicate.
 *
 * Once the Service has refused this build, retrying is asking the same question
 * of a Service whose answer is about the build rather than the request. The
 * predicate is the client-default `retry` and is composed first into
 * `retryProfileQuery`, because `setQueryDefaults(['/users/me'])` replaces the
 * client default rather than merging with it — without the composition the
 * profile read would keep its own retries after everything else stopped.
 *
 * It is load-bearing next to the shell unmount, not redundant with it: the
 * wardrobe list's coalescing loop can issue its one queued trailing read after
 * its observer is gone, and that read starts a fresh retryer no earlier cancel
 * can reach.
 */
export function retryUnlessClientVersionRefused(failureCount: number): boolean {
  if (isClientVersionRefused()) return false;
  return failureCount < DEFAULT_QUERY_RETRY_LIMIT;
}
