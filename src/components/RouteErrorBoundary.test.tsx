// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import RouteErrorBoundary from './RouteErrorBoundary';

function ThrowingChild(): React.ReactNode {
  throw new Error('Failed to fetch dynamically imported module');
}

describe('RouteErrorBoundary', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // React reports a caught render error to console.error; the boundary itself
    // is the behaviour under test.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleError.mockRestore();
  });

  function renderFailedBoundary(onReload: () => void) {
    return render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <RouteErrorBoundary onReload={onReload}>
          <ThrowingChild />
        </RouteErrorBoundary>
      </MemoryRouter>,
    );
  }

  it('renders the in-page failure card with the fixed copy', () => {
    renderFailedBoundary(vi.fn());

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("This page didn't load");
    expect(alert).toHaveTextContent(
      'The page could not be loaded. Check your connection and reload the app.',
    );
    expect(screen.getByRole('button', { name: 'Reload' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute('href', '/dashboard');
    expect(screen.getByRole('link', { name: 'Back to wardrobe' })).toHaveAttribute('href', '/wardrobe');
  });

  it('reloads through the injected control and offers no other recovery', () => {
    const onReload = vi.fn();
    renderFailedBoundary(onReload);

    // Reload is the only button: the two links navigate, they do not recover.
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('link', { name: 'Back to dashboard' }));
    fireEvent.click(screen.getByRole('link', { name: 'Back to wardrobe' }));
    expect(onReload).toHaveBeenCalledTimes(1);

    // The card survives the failed subtree instead of re-rendering it.
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('renders children while no error has been caught', () => {
    render(
      <MemoryRouter>
        <RouteErrorBoundary>
          <p>Routed content</p>
        </RouteErrorBoundary>
      </MemoryRouter>,
    );

    expect(screen.getByText('Routed content')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
