import React from 'react';
import { Link } from 'react-router-dom';

interface RouteErrorBoundaryProps {
  children: React.ReactNode;
  /** Tests inject this so the reload control can be observed without a document. */
  onReload?: () => void;
}

interface RouteErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * The in-page failure card for a route subtree. React caches a rejected `lazy()`
 * promise, so remounting the subtree re-throws it: a document reload is the only
 * recovery that can succeed, and that is the only recovery control offered here.
 * `Back to dashboard` and `Back to wardrobe` are ordinary router links, not
 * recovery controls.
 */
export default class RouteErrorBoundary extends React.Component<
  RouteErrorBoundaryProps,
  RouteErrorBoundaryState
> {
  constructor(props: RouteErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): RouteErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      const reload = this.props.onReload ?? (() => window.location.reload());
      return (
        <div
          role="alert"
          className="rounded-xl border border-gray-200 bg-white p-6 text-center shadow-sm"
        >
          <h2 className="text-xl font-semibold text-gray-900">This page didn&apos;t load</h2>
          <p className="mt-2 text-sm text-gray-600">
            The page could not be loaded. Check your connection and reload the app.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={reload}
              className="inline-flex items-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
            >
              Reload
            </button>
            <Link
              to="/dashboard"
              className="text-sm font-medium text-indigo-700 hover:text-indigo-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
            >
              Back to dashboard
            </Link>
            <Link
              to="/wardrobe"
              className="text-sm font-medium text-indigo-700 hover:text-indigo-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
            >
              Back to wardrobe
            </Link>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
