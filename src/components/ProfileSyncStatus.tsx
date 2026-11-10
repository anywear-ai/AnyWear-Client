import { useGetUsersMe } from '../api/endpoints/users/users';

/**
 * The non-blocking profile state inside the signed-in shell. It renders nothing
 * once a profile exists, and it never replaces the navigation or the routed
 * page: a pending or failed profile read is a notice beside the content, and its
 * retry re-runs the request instead of reloading the document.
 */
export default function ProfileSyncStatus() {
  const { data, isPending, isError, isFetching, refetch } = useGetUsersMe();

  if (data) return null;

  if (isPending) {
    return (
      <div
        role="status"
        className="mb-4 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600 shadow-sm"
      >
        Checking your profile...
      </div>
    );
  }

  if (isError) {
    return (
      <div
        role="status"
        className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-100 px-4 py-3 text-sm text-amber-800 shadow-sm"
      >
        <p>We couldn&apos;t load your profile. Some features may be unavailable until it loads.</p>
        <button
          type="button"
          onClick={() => { void refetch(); }}
          disabled={isFetching}
          className="inline-flex items-center rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Retry
        </button>
      </div>
    );
  }

  return null;
}
