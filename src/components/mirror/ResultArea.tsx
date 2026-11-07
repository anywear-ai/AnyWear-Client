import { useState, useEffect } from 'react';
import CachedImage from '../CachedImage';
import RatingWidget from './RatingWidget';
import type { VtoStatusResponse } from '../../api/model/vtoStatusResponse';

interface ResultAreaProps {
  vtoId: string | null;
  result: VtoStatusResponse | null;
  onRetry: () => void;
  onRate: (rating: number) => void;
  ratingError: string | null;
  ratingEchoResetToken?: number;
}

export default function ResultArea(props: ResultAreaProps) {
  return <ResultAreaContent key={props.vtoId ?? 'empty'} {...props} />;
}

function ResultAreaContent({ vtoId, result, onRetry, onRate, ratingError, ratingEchoResetToken }: ResultAreaProps) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const status = result?.status;
  const imageUrl = result?.url ?? null;
  const imageId = result?.imageId ?? null;
  const errorMessage = result?.error_message ?? null;
  // The stored rating comes from the same status read as the image and status.
  // An absent member from an older Service reads as unrated.
  const currentRating = result?.rating ?? null;

  useEffect(() => {
    if (!vtoId || !status || status === 'Complete' || status === 'Failed') return;
    const interval = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [vtoId, status]);

  if (!vtoId) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-8 text-center">
        <svg className="mx-auto h-10 w-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <p className="mt-2 text-sm text-gray-500">Generate your first try-on above</p>
      </div>
    );
  }

  if (status === 'Pending' || status === 'Processing') {
    return (
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 sm:p-6" role="status" aria-live="polite">
        <div className="animate-pulse space-y-4">
          <div className="bg-gray-200 rounded-lg h-64 w-full" />
          <div className="h-4 bg-gray-200 rounded w-3/4" />
          <div className="h-4 bg-gray-200 rounded w-1/2" />
        </div>
        <div className="mt-4 text-center">
          <svg className="animate-spin inline-block h-5 w-5 text-indigo-600 mr-2" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span className="text-sm font-medium text-gray-700">
            Creating your preview · {elapsedSeconds}s elapsed
          </span>
        </div>
      </div>
    );
  }

  if (status === 'Failed') {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-5" role="alert">
        <div className="flex items-start gap-3">
          <svg className="w-5 h-5 text-red-500 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div className="flex-1">
            <h4 className="text-sm font-medium text-red-800">Generation Failed</h4>
            <p className="mt-1 text-sm text-red-600">{errorMessage || 'An unknown error occurred.'}</p>
          </div>
        </div>
        <button
          onClick={onRetry}
          className="mt-4 inline-flex items-center px-3 py-1.5 border border-red-300 text-sm font-medium rounded-md text-red-700 bg-white hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-red-500"
        >
          Retry
        </button>
      </div>
    );
  }

  if (status === 'Complete' && imageUrl) {
    return (
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <CachedImage
          src={imageUrl}
          cacheKey={`vto-result-${imageId ?? vtoId}`}
          alt="Try-on result"
          className="mx-auto max-h-[70vh] w-full object-contain"
        />
        <div className="p-4 border-t border-gray-100">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <RatingWidget
              rating={currentRating}
              onChange={onRate}
              echoResetToken={ratingEchoResetToken}
            />
            <button
              onClick={onRetry}
              className="inline-flex items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-indigo-500"
            >
              <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Retry
            </button>
          </div>
          {ratingError && (
            <p role="alert" className="mt-2 text-xs text-red-700">
              {ratingError}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
      <svg className="mx-auto h-10 w-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <p className="mt-2 text-sm text-gray-500">Waiting for result...</p>
    </div>
  );
}
