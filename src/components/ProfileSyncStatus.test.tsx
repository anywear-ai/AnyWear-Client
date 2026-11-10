// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../api/endpoints/users/users', () => ({
  useGetUsersMe: vi.fn(),
}));

import ProfileSyncStatus from './ProfileSyncStatus';
import { useGetUsersMe } from '../api/endpoints/users/users';

function mockProfile(overrides: Record<string, unknown>) {
  vi.mocked(useGetUsersMe).mockReturnValue({
    data: undefined,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
    ...overrides,
  } as never);
}

describe('ProfileSyncStatus', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders nothing once a profile exists', () => {
    mockProfile({ data: { id: 'test-user-id', dailyCredits: 8 } });
    const { container } = render(<ProfileSyncStatus />);

    expect(container).toBeEmptyDOMElement();
  });

  it('names the pending profile read without blocking the page', () => {
    mockProfile({ isPending: true });
    const { container } = render(<ProfileSyncStatus />);

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Checking your profile...');
    expect(notice).not.toHaveClass('fixed');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('reports a failed read and retries the request instead of reloading', () => {
    const refetch = vi.fn();
    mockProfile({ isError: true, refetch });
    render(<ProfileSyncStatus />);

    expect(screen.getByRole('status')).toHaveTextContent(
      "We couldn't load your profile. Some features may be unavailable until it loads.",
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('disables Retry while a retry is in flight', () => {
    mockProfile({ isError: true, isFetching: true });
    render(<ProfileSyncStatus />);

    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
  });

  it('renders nothing when a cached profile survives a failed refetch', () => {
    mockProfile({
      status: 'success',
      data: { id: 'test-user-id', dailyCredits: 8 },
      failureCount: 1,
      isError: false,
    });
    const { container } = render(<ProfileSyncStatus />);

    expect(container).toBeEmptyDOMElement();
  });
});
