import { QueryClient } from '@tanstack/react-query';
import { registerProfileQueryPolicy } from './profileQueryPolicy';
import { retryUnlessClientVersionRefused } from './queryRetryPolicy';

/**
 * The one QueryClient for the document.
 *
 * It lives here rather than in `App.tsx` because two modules need the instance:
 * the shell provides it, and the Axios response interceptor cancels everything
 * in flight or scheduled when the Service refuses this build. No import cycle
 * is possible — nothing this module imports reaches `api/custom-instance.ts`.
 *
 * The only difference from the previous `new QueryClient()` is the retry
 * predicate; the construction is otherwise unchanged, and the profile policy is
 * still registered on the same instance.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: retryUnlessClientVersionRefused,
    },
  },
});

// Every `useGetUsersMe` consumer inherits the one retry policy registered here.
registerProfileQueryPolicy(queryClient);
