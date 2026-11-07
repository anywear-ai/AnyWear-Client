// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import OutfitPicker from './OutfitPicker';
import { OUTFIT_LOOK_POLL_INTERVAL_MS } from '../../lib/outfit-look';

const LOOK_URL = 'https://anywear-beta.s3.amazonaws.com/outfit-generations/user-1/outfit-1/gen-1.png?X-Amz-Signature=signed';
const ITEM_URL = 'https://example.com/tshirt.jpg?X-Amz-Signature=signed';

const mockOutfits = {
  outfits: [
    {
      id: 'outfit-1',
      name: 'Weekend Casual',
      userId: 'user-1',
      createdAt: '2026-05-05T00:00:00.000Z',
      wearableItems: [
        { id: 'item-1', name: 'T-Shirt', category: 'Top', images: [{ imageId: 'image-1', url: ITEM_URL, view: null, isPrimary: true }] },
        { id: 'item-2', name: 'Jeans', category: 'Bottom', images: [] },
      ],
      latestGeneration: { id: 'gen-1', status: 'Complete', errorCode: null, createdAt: '2026-06-01T00:00:00.000Z' },
      look: { generationId: 'gen-1', url: LOOK_URL, createdAt: '2026-06-01T00:00:00.000Z' },
    },
    {
      id: 'outfit-2',
      name: null,
      userId: 'user-1',
      createdAt: '2026-05-04T00:00:00.000Z',
      wearableItems: [],
      latestGeneration: null,
      look: null,
    },
  ],
};

vi.mock('../../api/endpoints/outfits/outfits', () => ({
  useGetOutfits: vi.fn(),
}));

vi.mock('../CachedImage', () => ({
  default: ({ src, cacheKey, alt, className, ...rest }: any) => (
    <img src={src} alt={alt} className={className} data-cache-key={cacheKey} {...rest} />
  ),
}));

import { useGetOutfits } from '../../api/endpoints/outfits/outfits';

function mockData(data: unknown, isLoading = false) {
  vi.mocked(useGetOutfits).mockReturnValue({ data, isLoading, isError: false } as any);
}

describe('OutfitPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it('shows loading state', () => {
    mockData(undefined, true);

    render(<OutfitPicker selectedOutfitId={null} onSelect={() => {}} />);

    expect(screen.getByText('Loading outfits...')).toBeDefined();
  });

  it('shows empty state when no outfits exist', () => {
    mockData({ outfits: [] });

    render(<OutfitPicker selectedOutfitId={null} onSelect={() => {}} />);

    expect(screen.getByText('No saved outfits yet.')).toBeDefined();
    expect(screen.getByText(/Select Items/)).toBeDefined();
  });

  it('renders outfits from the API response', () => {
    mockData(mockOutfits);

    render(<OutfitPicker selectedOutfitId={null} onSelect={() => {}} />);

    expect(screen.getByText('Weekend Casual')).toBeDefined();
    expect(screen.getByText('Untitled Outfit')).toBeDefined();
    expect(screen.getByText('2 items')).toBeDefined();
    expect(screen.getByText('0 items')).toBeDefined();
  });

  it('renders a Service-derived name verbatim beside the unnamed fallback', () => {
    const derivedNameOutfit = {
      ...structuredClone(mockOutfits.outfits[0]),
      id: 'outfit-3',
      name: 'T-Shirt, Jeans',
      wearableItems: [],
      latestGeneration: null,
      look: null,
    };
    mockData({ outfits: [mockOutfits.outfits[1], derivedNameOutfit] });

    render(<OutfitPicker selectedOutfitId={null} onSelect={() => {}} />);

    expect(screen.getByText('Untitled Outfit')).toBeDefined();
    expect(screen.getByText('T-Shirt, Jeans')).toBeDefined();
  });

  it('renders the completed look with the same per-generation cache key as the Wardrobe card', () => {
    mockData(mockOutfits);

    render(<OutfitPicker selectedOutfitId={null} onSelect={() => {}} />);

    const image = screen.getByTestId('outfit-thumbnail-outfit-1');
    expect(image).toHaveAttribute('src', LOOK_URL);
    expect(image).toHaveAttribute('data-cache-key', 'outfit-look-gen-1');
    expect(image).toHaveAttribute('alt', '');

    // The nested item's image is never a fallback for the outfit's look.
    expect(document.querySelector(`img[src="${ITEM_URL}"]`)).toBeNull();
  });

  it('shows the empty look for an outfit without a completed generation', () => {
    mockData(structuredClone(mockOutfits));

    render(<OutfitPicker selectedOutfitId={null} onSelect={() => {}} />);

    expect(screen.queryByTestId('outfit-thumbnail-outfit-2')).toBeNull();
    expect(screen.queryByTestId('outfit-look-badge-pending')).toBeNull();
  });

  it.each(['Pending', 'Processing', 'Failed'])('renders the %s badge without an action', (status) => {
    const data = structuredClone(mockOutfits);
    Object.assign(data.outfits[1], {
      latestGeneration: { id: `gen-${status}`, status, errorCode: null, createdAt: '2026-06-02T00:00:00.000Z' },
    });
    mockData(data);

    render(<OutfitPicker selectedOutfitId={null} onSelect={() => {}} />);

    expect(screen.getByTestId(`outfit-look-badge-${status.toLowerCase()}`)).toHaveTextContent(status);
    // The picker's only action is selecting the outfit.
    expect(screen.queryByRole('button', { name: /Generate look|Retry|New look/ })).toBeNull();
  });

  it('polls the outfits query only while a returned generation is Pending or Processing', () => {
    mockData(structuredClone(mockOutfits));

    render(<OutfitPicker selectedOutfitId={null} onSelect={() => {}} />);

    const options = vi.mocked(useGetOutfits).mock.lastCall?.[0];
    const refetchInterval = options?.query?.refetchInterval;
    expect(refetchInterval).toBeTypeOf('function');

    // Mirrors the Wardrobe list: the same shared interval while any returned
    // generation is active, and false once every one of them is terminal.
    const intervalFor = refetchInterval as unknown as (
      query: { state: { data: unknown } },
    ) => number | false;

    expect(intervalFor({
      state: { data: { outfits: [{ latestGeneration: { status: 'Processing' } }] } },
    })).toBe(OUTFIT_LOOK_POLL_INTERVAL_MS);
    expect(intervalFor({
      state: {
        data: {
          outfits: [
            { latestGeneration: { status: 'Complete' } },
            { latestGeneration: { status: 'Pending' } },
          ],
        },
      },
    })).toBe(OUTFIT_LOOK_POLL_INTERVAL_MS);
    expect(intervalFor({
      state: {
        data: {
          outfits: [
            { latestGeneration: { status: 'Complete' } },
            { latestGeneration: { status: 'Failed' } },
          ],
        },
      },
    })).toBe(false);
    expect(intervalFor({ state: { data: { outfits: [] } } })).toBe(false);
    expect(intervalFor({ state: { data: undefined } })).toBe(false);
  });

  it('calls onSelect when an outfit is clicked', () => {
    const onSelect = vi.fn();
    mockData(mockOutfits);

    render(<OutfitPicker selectedOutfitId={null} onSelect={onSelect} />);

    fireEvent.click(screen.getByText('Weekend Casual'));
    expect(onSelect).toHaveBeenCalledWith('outfit-1');
  });

  it('highlights selected outfit', () => {
    mockData(mockOutfits);

    render(<OutfitPicker selectedOutfitId="outfit-1" onSelect={() => {}} />);

    const selectedButton = screen.getByText('Weekend Casual').closest('button');
    expect(selectedButton?.getAttribute('aria-pressed')).toBe('true');
    expect(selectedButton?.className).toContain('border-indigo-600');
  });
});
