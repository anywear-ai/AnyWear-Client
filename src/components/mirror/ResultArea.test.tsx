// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../CachedImage', () => ({
  default: ({ src, alt, className }: { src: string; alt: string; className?: string }) => (
    <img src={src} alt={alt} className={className} />
  ),
}));

import ResultArea from './ResultArea';
import type { VtoStatusResponse } from '../../api/model/vtoStatusResponse';

const SAVE_FAILURE = "Couldn't save your rating. Choose a star to try again.";

function status(overrides: Partial<VtoStatusResponse> = {}): VtoStatusResponse {
  return {
    generation_id: 'generation-1',
    status: 'Complete',
    state_version: 3,
    imageId: 'image-1',
    url: 'https://example.com/result.jpg',
    created_at: '2026-11-07T00:00:00.000Z',
    rating: null,
    ...overrides,
  };
}

function renderResult(result: VtoStatusResponse | null, options: {
  vtoId?: string | null;
  ratingError?: string | null;
  ratingEchoResetToken?: number;
} = {}) {
  const props = {
    vtoId: 'generation-1' as string | null,
    result,
    onRetry: vi.fn(),
    onRate: vi.fn(),
    ratingError: null as string | null,
    ratingEchoResetToken: 0,
    ...options,
  };
  const rendered = render(<ResultArea {...props} />);
  return { ...rendered, props };
}

function star(name: string) {
  return screen.getByRole('radio', { name });
}

describe('ResultArea rating', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the stored rating as the checked star and the stored sentence', () => {
    renderResult(status({ rating: 3 }));

    expect(star('3 stars')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Your rating: 3/5')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Your rating: 3 out of 5')).toBeInTheDocument();
    expect(screen.queryByText(/of 5 selected/)).toBeNull();
  });

  it('states a failed save in one alert under the star row', () => {
    renderResult(status({ rating: 2 }), { ratingError: SAVE_FAILURE });

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(SAVE_FAILURE);
    // The stored value is still what the control shows.
    expect(star('2 stars')).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByText(/of 5 selected/)).toBeNull();
  });

  it('clears the pending echo on a reset-token change without moving focus', () => {
    const { rerender, props } = renderResult(status({ rating: null }), { ratingEchoResetToken: 0 });
    star('4 stars').focus();
    fireEvent.click(star('4 stars'));
    expect(screen.getByText('4 of 5 selected')).toBeInTheDocument();

    rerender(<ResultArea {...props} ratingEchoResetToken={1} />);

    expect(screen.queryByText('4 of 5 selected')).toBeNull();
    expect(screen.getByText('Rate this result')).toBeInTheDocument();
    expect(screen.queryByText(/Your rating:/)).toBeNull();
    expect(star('4 stars')).toHaveFocus();
  });

  it('shows a selection as pending and never as stored while it is in flight', () => {
    renderResult(status({ rating: 3 }));

    star('4 stars').focus();
    fireEvent.click(star('4 stars'));

    expect(screen.getByText('4 of 5 selected')).toBeInTheDocument();
    expect(screen.queryByText(/Your rating:/)).toBeNull();
  });

  it('shows a stored zero with no filled star and star one as the tab stop', () => {
    const { container } = renderResult(status({ rating: 0 }));

    expect(screen.getByText('Your rating: 0/5')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Your rating: 0 out of 5')).toBeInTheDocument();
    expect(container.querySelector('.text-indigo-500')).toBeNull();
    expect(star('1 star')).toHaveAttribute('tabindex', '0');
    screen.getAllByRole('radio').forEach((button) => {
      expect(button).toHaveAttribute('aria-checked', 'false');
    });
  });

  it('renders the empty state with no rating control when no generation exists', () => {
    renderResult(null, { vtoId: null });

    expect(screen.getByText('Generate your first try-on above')).toBeInTheDocument();
    expect(screen.queryAllByRole('radiogroup')).toHaveLength(0);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });
});
