/**
 * The page-area wait for a route module. It is content-sized by design: the
 * navigation stays visible and usable because this card never leaves the page
 * column, unlike the full-page bootstrap overlay.
 */
export default function RouteLoading({ destination }: { destination: string }) {
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-white px-6 py-12 text-center shadow-sm"
    >
      <div
        aria-hidden="true"
        className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-200 border-t-indigo-600"
      />
      <p className="mt-4 text-sm font-medium text-gray-600">Loading {destination}...</p>
    </div>
  );
}
