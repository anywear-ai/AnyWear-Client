// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';

import RouteLoading from './RouteLoading';
import { routeDestinationName } from '../lib/routeDestination';

describe('routeDestinationName', () => {
  it.each([
    ['/dashboard', 'dashboard'],
    ['/wardrobe', 'wardrobe'],
    ['/mirror', 'the mirror'],
    ['/settings', 'settings'],
    ['/login', 'sign in'],
    ['/register', 'registration'],
    ['/verify', 'email verification'],
    ['/unknown', 'page'],
    ['/', 'page'],
  ])('names %s as %s', (pathname, destination) => {
    expect(routeDestinationName(pathname)).toBe(destination);
  });
});

describe('RouteLoading', () => {
  afterEach(cleanup);

  it('announces the wait and names the destination without covering the page', () => {
    render(<RouteLoading destination={routeDestinationName('/dashboard')} />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading dashboard...');
    expect(status).not.toHaveClass('fixed');
    expect(status.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('renders the destination it is given', () => {
    render(<RouteLoading destination={routeDestinationName('/mirror')} />);

    expect(screen.getByText('Loading the mirror...')).toBeVisible();
  });
});
