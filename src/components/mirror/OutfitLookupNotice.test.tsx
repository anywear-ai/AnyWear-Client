// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import OutfitLookupNotice from './OutfitLookupNotice';

vi.mock('../CachedImage', () => ({
  default: ({ src, cacheKey, alt, className }: any) => (
    <img src={src} alt={alt} className={className} data-cache-key={cacheKey} />
  ),
}));

function matchedOutfit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'outfit-1',
    userId: 'user-1',
    name: 'Weekend Casual',
    memberSignature: 'a'.repeat(64),
    wearableItems: [],
    createdAt: '2026-05-05T00:00:00.000Z',
    latestGeneration: null,
    look: {
      generationId: 'generation-1',
      url: 'https://signed.example.com/look.png',
      createdAt: '2026-06-02T00:00:00.000Z',
    },
    generationCount: 3,
    ...overrides,
  } as never;
}

/**
 * Issue 335 — the lookup hit is what the user sees before a credit is charged.
 *
 * It names the outfit, shows its latest completed look and states how many try-on
 * records it already has, so pressing Try on is an informed choice rather than a
 * charge for a set that already exists.
 */
describe('OutfitLookupNotice', () => {
  beforeEach(() => cleanup());

  it('renders nothing when there is no match', () => {
    const { container } = render(<OutfitLookupNotice outfit={null} isLoading={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('outfit-lookup-hit')).toBeNull();
  });

  it('renders nothing while the lookup is still running', () => {
    render(<OutfitLookupNotice outfit={matchedOutfit()} isLoading />);
    expect(screen.queryByTestId('outfit-lookup-hit')).toBeNull();
  });

  it('names the outfit and shows its existing try-on record count', () => {
    render(<OutfitLookupNotice outfit={matchedOutfit()} isLoading={false} />);

    const notice = screen.getByTestId('outfit-lookup-hit');
    expect(notice).toHaveTextContent('Weekend Casual');
    expect(notice).toHaveTextContent('3 try-on records');
    // Issue 350 — the credit promise names the control that actually spends it.
    expect(notice).toHaveTextContent('no credit is spent until you press Generate try-on');
  });

  it('uses the singular for one record and a true zero for none', () => {
    const { unmount } = render(
      <OutfitLookupNotice outfit={matchedOutfit({ generationCount: 1 })} isLoading={false} />,
    );
    expect(screen.getByTestId('outfit-lookup-hit')).toHaveTextContent('1 try-on record');
    unmount();

    render(<OutfitLookupNotice outfit={matchedOutfit({ generationCount: 0 })} isLoading={false} />);
    expect(screen.getByTestId('outfit-lookup-hit')).toHaveTextContent('0 try-on records');
  });

  it('shows the latest completed look with a cache key naming its generation', () => {
    render(<OutfitLookupNotice outfit={matchedOutfit()} isLoading={false} />);

    const image = screen.getByRole('img', { name: /Latest look for Weekend Casual/ });
    expect(image).toHaveAttribute('src', 'https://signed.example.com/look.png');
    expect(image).toHaveAttribute('data-cache-key', 'outfit-look-generation-1');
  });

  it('falls back to the no-look state when the outfit has no completed look', () => {
    render(<OutfitLookupNotice outfit={matchedOutfit({ look: null })} isLoading={false} />);

    expect(screen.getByTestId('outfit-lookup-hit')).toHaveTextContent('No look');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('names an untitled outfit without inventing one', () => {
    render(<OutfitLookupNotice outfit={matchedOutfit({ name: null })} isLoading={false} />);
    expect(screen.getByTestId('outfit-lookup-hit')).toHaveTextContent('This outfit');
  });
});
