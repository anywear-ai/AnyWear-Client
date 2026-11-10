// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../api/endpoints/weather/weather', () => ({
  useGetWeatherCurrent: vi.fn(),
}));

import WeatherWidget from './WeatherWidget';
import { useGetWeatherCurrent } from '../../api/endpoints/weather/weather';
import type { GetWeatherCurrent200 } from '../../api/model';

const WEATHER: GetWeatherCurrent200 = {
  locationName: 'Hangzhou, Zhejiang',
  temperature: '22',
  feelsLike: '24',
  icon: '100',
  conditionText: 'Sunny',
  humidity: '45',
  windDir: 'North',
  windScale: '1',
  obsTime: '2026-11-10T10:00:00Z',
  stale: false,
  clothingIndex: {
    level: '1',
    category: 'comfortable',
    suggestion: 'Light clothing is enough.',
  },
};

function mockWeather(overrides: Record<string, unknown>) {
  vi.mocked(useGetWeatherCurrent).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  } as never);
}

function renderWidget() {
  return render(
    <MemoryRouter>
      <WeatherWidget />
    </MemoryRouter>,
  );
}

describe('WeatherWidget', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('names the data it waits for while the first read is pending', () => {
    mockWeather({ isLoading: true });
    renderWidget();

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading weather...');
    // The placeholders are decorative; the sentence carries the state.
    expect(status.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Set Location' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByText('Unable to load weather data. Please try again later.')).toBeNull();
  });

  it('keeps Set Location for a 404 and shows no failure card', () => {
    mockWeather({ isError: true, error: { response: { status: 404 } } });
    renderWidget();

    expect(screen.getByRole('button', { name: 'Set Location' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByText('Unable to load weather data. Please try again later.')).toBeNull();
  });

  it('offers Retry for a non-404 failure and re-runs the same read', () => {
    const refetch = vi.fn();
    mockWeather({ isError: true, error: { response: { status: 500 } }, refetch });
    renderWidget();

    expect(screen.getByText('Unable to load weather data. Please try again later.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps a cached reading when a later refresh fails', () => {
    mockWeather({
      data: WEATHER,
      isError: true,
      error: { response: { status: 500 } },
    });
    renderWidget();

    expect(screen.getByText('Hangzhou, Zhejiang')).toBeVisible();
    expect(screen.getByText('22°C')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
