import { useGetWeatherCurrent } from '../../api/endpoints/weather/weather';
import type { GetWeatherCurrent200 } from '../../api/model';
import { useNavigate } from 'react-router-dom';
import { getHttpStatus } from '../../lib/errors';

/**
 * Maps QWeather icon codes to emoji representations.
 * See https://dev.qweather.com/en/docs/resource/icons/ for full list.
 */
function weatherIconEmoji(iconCode: string): string {
  const code = parseInt(iconCode, 10);
  if (code >= 100 && code <= 103) return '\u2600\uFE0F'; // sunny / mostly clear
  if (code >= 104 && code <= 199) return '\u2601\uFE0F'; // overcast / cloudy
  if (code >= 300 && code <= 399) return '\uD83C\uDF27\uFE0F'; // rain
  if (code >= 400 && code <= 499) return '\u2744\uFE0F'; // snow
  if (code >= 500 && code <= 599) return '\uD83C\uDF2B\uFE0F'; // fog / haze
  return '\uD83C\uDF24\uFE0F'; // default
}

function WeatherWidgetSkeleton() {
  return (
    <div role="status" className="bg-white shadow rounded-lg p-6">
      <p className="mb-4 text-sm font-medium text-gray-600">Loading weather...</p>
      <div aria-hidden="true" className="animate-pulse">
        <div className="flex items-center justify-between mb-4">
          <div className="h-4 bg-gray-200 rounded w-40" />
          <div className="h-3 bg-gray-200 rounded w-24" />
        </div>
        <div className="flex items-center gap-6 mb-4">
          <div className="h-16 w-16 bg-gray-200 rounded-full" />
          <div className="space-y-2">
            <div className="h-8 bg-gray-200 rounded w-20" />
            <div className="h-4 bg-gray-200 rounded w-32" />
          </div>
        </div>
        <div className="flex gap-4 mb-4">
          <div className="h-4 bg-gray-200 rounded w-16" />
          <div className="h-4 bg-gray-200 rounded w-24" />
        </div>
        <div className="h-16 bg-gray-100 rounded w-full" />
      </div>
    </div>
  );
}

function WeatherWidgetEmpty() {
  const navigate = useNavigate();

  return (
    <div className="bg-white shadow rounded-lg p-6 text-center">
      <p className="text-gray-500 text-sm mb-3">
        Set your location to see today&apos;s weather and clothing recommendations.
      </p>
      <button
        onClick={() => navigate('/settings')}
        className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
      >
        Set Location
      </button>
    </div>
  );
}

function WeatherWidgetError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="bg-white shadow rounded-lg p-6 text-center">
      <p className="text-red-500 text-sm">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 inline-flex items-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
      >
        Retry
      </button>
    </div>
  );
}

function WeatherWidgetContent({ data }: { data: GetWeatherCurrent200 }) {
  return (
    <div className="bg-white shadow rounded-lg p-6">
      {/* Header: location + stale indicator */}
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm font-medium text-gray-600">
          {data.locationName}
        </span>
        <span className="text-xs text-gray-400">
          {data.stale && (
            <span className="text-amber-500 mr-2" title="Data may be outdated">
              Outdated
            </span>
          )}
          {data.obsTime
            ? new Date(data.obsTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : ''}
        </span>
      </div>

      {/* Main weather display */}
      <div className="flex items-center gap-6 mb-4">
        <span className="text-5xl" role="img" aria-label="weather icon">
          {weatherIconEmoji(data.icon)}
        </span>
        <div>
          <p className="text-4xl font-bold text-gray-900">{data.temperature}&deg;C</p>
          <p className="text-sm text-gray-500">
            {data.conditionText} &middot; Feels like {data.feelsLike}&deg;C
          </p>
        </div>
      </div>

      {/* Secondary info */}
      <div className="flex gap-4 text-xs text-gray-500 mb-4">
        <span>Humidity {data.humidity}%</span>
        <span>{data.windDir} Lv.{data.windScale}</span>
      </div>

      {/* Clothing suggestion — the key value-add */}
      {data.clothingIndex && (
        <div className="bg-blue-50 border border-blue-100 rounded-md p-4">
          <p className="text-xs font-semibold text-blue-700 mb-1">
            Clothing Suggestion
          </p>
          <p className="text-sm text-blue-900 leading-relaxed line-clamp-2">
            {data.clothingIndex.suggestion}
          </p>
        </div>
      )}
    </div>
  );
}

export default function WeatherWidget() {
  const { data, isLoading, isError, error, refetch } = useGetWeatherCurrent({
    query: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      refetchOnWindowFocus: true,
      retry: 1,
    },
  });

  if (isLoading) {
    return <WeatherWidgetSkeleton />;
  }

  // 404 means no location configured
  if (isError && !data) {
    const status = getHttpStatus(error);
    if (status === 404) {
      return <WeatherWidgetEmpty />;
    }
    return (
      <WeatherWidgetError
        message="Unable to load weather data. Please try again later."
        onRetry={() => { void refetch(); }}
      />
    );
  }

  // A failed refresh keeps the cached reading on screen; only a first read with
  // no data reaches the failure card above.
  if (!data) {
    return <WeatherWidgetEmpty />;
  }

  return <WeatherWidgetContent data={data} />;
}
