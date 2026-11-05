// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import WardrobePage from './WardrobePage';

const LOOK_URL = 'https://anywear-beta.s3.amazonaws.com/outfit-generations/user-1/outfit-1/gen-1.png?X-Amz-Signature=signed';
const ITEM_URL = 'https://anywear-beta.s3.amazonaws.com/wardrobe/coat.jpg?X-Amz-Signature=signed';

interface CreateOutfitModalMockProps {
  isOpen: boolean;
  onClose?: () => void;
  onSaved?: (outfit: { id: string; name?: string | null }) => void;
  outfit?: { id: string; name?: string | null } | null;
}

const createOutfitModal = vi.hoisted(() => ({
  props: null as CreateOutfitModalMockProps | null,
}));

interface AddItemModalMockProps {
  isOpen: boolean;
  onClose?: () => void;
  onSuccess?: () => void;
  items?: Array<{ id: string; taggingStatus: string; taggingErrorCode?: string | null }>;
  onItemsCreated?: () => void;
}

const addItemModal = vi.hoisted(() => ({
  props: null as AddItemModalMockProps | null,
}));

vi.mock('../../api/endpoints/wardrobe/wardrobe', () => ({
  useGetWardrobe: vi.fn(),
  useGetWardrobeCategories: vi.fn(),
  useDeleteWardrobeItemsId: vi.fn(),
}));

vi.mock('../../api/endpoints/outfits/outfits', () => ({
  useGetOutfits: vi.fn(),
}));

vi.mock('../../api/endpoints/vto/vto', () => ({
  usePostVtoGenerations: vi.fn(),
}));

vi.mock('../../components/CachedImage', () => ({
  default: ({ src, cacheKey, alt, className, ...rest }: any) => (
    <img src={src} alt={alt} className={className} data-cache-key={cacheKey} {...rest} />
  ),
}));

vi.mock('./AddItemModal', () => ({
  default: (props: AddItemModalMockProps) => {
    // Record the real props so the tests can invoke the page's own onItemsCreated
    // wiring instead of relying on this stand-in.
    addItemModal.props = props;
    return null;
  },
}));
vi.mock('./ItemDetailsModal', () => ({ default: () => null }));
vi.mock('./CreateOutfitModal', async () => {
  const { default: useAccessibleDialog } = await import('../../hooks/useAccessibleDialog');

  function StandInCreateOutfitModal(props: CreateOutfitModalMockProps) {
    // The real dialog holds one counted body lock while it is open; the stand-in
    // runs the same hook so the page's overlap wiring is exercised against real
    // locking instead of a stub that never locks.
    const dialogRef = useAccessibleDialog(() => {}, props.isOpen);
    if (!props.isOpen) return null;
    return (
      <div ref={dialogRef} data-testid="create-outfit-stand-in" tabIndex={-1}>
        <button
          type="button"
          onClick={() => props.onSaved?.({
            id: props.outfit?.id ?? 'outfit-1',
            name: props.outfit?.name ?? 'Rainy Day',
          })}
        >
          Save outfit
        </button>
        <button type="button" onClick={() => props.onClose?.()}>Close outfit</button>
      </div>
    );
  }

  return {
    default: (props: CreateOutfitModalMockProps) => {
      // Record the real props so the tests can call the page's own onSaved wiring
      // in both create and edit mode instead of relying on this stand-in.
      createOutfitModal.props = props;
      return <StandInCreateOutfitModal {...props} />;
    },
  };
});
vi.mock('../../lib/sse', () => ({ connectSse: () => ({ close: () => {} }) }));

import { useGetOutfits } from '../../api/endpoints/outfits/outfits';
import {
  useGetWardrobe,
  useGetWardrobeCategories,
  useDeleteWardrobeItemsId,
} from '../../api/endpoints/wardrobe/wardrobe';
import { usePostVtoGenerations } from '../../api/endpoints/vto/vto';

const generateLook = vi.fn();

function outfit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'outfit-1',
    name: 'Rainy Day',
    userId: 'user-1',
    createdAt: '2026-05-05T00:00:00.000Z',
    wearableItems: [
      { id: 'item-1', name: 'Coat', category: 'Outerwear', images: [{ imageId: 'image-coat', url: ITEM_URL, view: null, isPrimary: true }] },
    ],
    latestGeneration: null,
    look: null,
    ...overrides,
  };
}

function outfitResponse(outfitItem: Record<string, unknown>) {
  return { outfits: [outfitItem] };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <WardrobePage />
    </QueryClientProvider>,
  );
  return { ...rendered, queryClient };
}

function mockOutfits(data: ReturnType<typeof outfitResponse> | undefined) {
  vi.mocked(useGetOutfits).mockReturnValue({ data, isLoading: false } as any);
}

describe('WardrobePage saved outfit look cards', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    createOutfitModal.props = null;
    addItemModal.props = null;
    generateLook.mockReset();
    generateLook.mockResolvedValue({ generation_id: 'gen-2', outfit_id: 'outfit-1' });
    vi.mocked(useGetWardrobe).mockReturnValue({ data: [], isLoading: false } as any);
    vi.mocked(useGetWardrobeCategories).mockReturnValue({ data: { categories: [] } } as any);
    vi.mocked(useDeleteWardrobeItemsId).mockReturnValue({ mutate: vi.fn() } as any);
    vi.mocked(usePostVtoGenerations).mockReturnValue({ mutateAsync: generateLook, isPending: false } as any);
    mockOutfits(outfitResponse(outfit()));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the completed look URL with a cache key that names its generation', () => {
    mockOutfits(outfitResponse(outfit({
      latestGeneration: { id: 'gen-1', status: 'Complete', errorCode: null, createdAt: '2026-06-01T00:00:00.000Z' },
      look: { generationId: 'gen-1', url: LOOK_URL, createdAt: '2026-06-01T00:00:00.000Z' },
    })));

    renderPage();

    const image = screen.getByTestId('outfit-thumbnail-outfit-1');
    expect(image).toHaveAttribute('src', LOOK_URL);
    expect(image).toHaveAttribute('data-cache-key', 'outfit-look-gen-1');
    expect(screen.queryByTestId('outfit-look-badge-pending')).toBeNull();
    expect(screen.getByRole('button', { name: 'New look for Rainy Day' })).toBeInTheDocument();
  });

  it('never derives the image from wearable items: no look shows the empty state and Generate look', () => {
    renderPage();

    expect(screen.queryByTestId('outfit-thumbnail-outfit-1')).toBeNull();
    expect(screen.getByText('No look yet')).toBeInTheDocument();
    expect(document.querySelector(`img[src="${ITEM_URL}"]`)).toBeNull();
    expect(screen.getByRole('button', { name: 'Generate look for Rainy Day' })).toBeInTheDocument();
    expect(screen.getByText('1 items')).toBeInTheDocument();
  });

  it('shows Pending as a live state and offers no second action while it is active', () => {
    mockOutfits(outfitResponse(outfit({
      latestGeneration: { id: 'gen-2', status: 'Pending', errorCode: null, createdAt: '2026-06-02T00:00:00.000Z' },
    })));

    renderPage();

    expect(screen.getByTestId('outfit-look-badge-pending')).toHaveTextContent('Pending');
    expect(screen.getByText('Generating look...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Generate look for/ })).toBeNull();
  });

  it('shows Processing as a live state without an action', () => {
    mockOutfits(outfitResponse(outfit({
      latestGeneration: { id: 'gen-2', status: 'Processing', errorCode: null, createdAt: '2026-06-02T00:00:00.000Z' },
    })));

    renderPage();

    expect(screen.getByTestId('outfit-look-badge-processing')).toHaveTextContent('Processing');
    expect(screen.queryByRole('button', { name: /Generate look for/ })).toBeNull();
  });

  it('shows Failed with Retry while keeping the older completed look', () => {
    mockOutfits(outfitResponse(outfit({
      latestGeneration: { id: 'gen-2', status: 'Failed', errorCode: 'base_photo_unavailable', createdAt: '2026-06-02T00:00:00.000Z' },
      look: { generationId: 'gen-1', url: LOOK_URL, createdAt: '2026-06-01T00:00:00.000Z' },
    })));

    renderPage();

    expect(screen.getByTestId('outfit-look-badge-failed')).toHaveTextContent('Failed');
    expect(screen.getByTestId('outfit-thumbnail-outfit-1')).toHaveAttribute('src', LOOK_URL);
    expect(screen.getByRole('button', { name: 'Retry for Rainy Day' })).toBeInTheDocument();
  });

  it('starts nothing on load; Cancel in the confirmation spends nothing', async () => {
    renderPage();

    expect(generateLook).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Generate look for Rainy Day' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('This uses 1 of your daily credits.');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(generateLook).not.toHaveBeenCalled();
  });

  it('confirms a generation without base_photo_id and refreshes the outfits and user queries', async () => {
    const { queryClient } = renderPage();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    fireEvent.click(screen.getByRole('button', { name: 'Generate look for Rainy Day' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate look (1 credit)' }));

    await waitFor(() => expect(generateLook).toHaveBeenCalledTimes(1));
    expect(generateLook).toHaveBeenCalledWith({ data: { outfit_id: 'outfit-1' } });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['/outfits'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['/users/me'] });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('surfaces the exhausted-credits response and keeps the dialog open', async () => {
    generateLook.mockRejectedValueOnce({
      response: {
        status: 429,
        data: { error: 'daily_credits_exhausted', message: 'Daily AI credits exhausted. Resets tomorrow.' },
      },
    });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Generate look for Rainy Day' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate look (1 credit)' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Daily AI credits exhausted. Resets tomorrow.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('offers the same confirmed action after saving an outfit', async () => {
    mockOutfits({ outfits: [] });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Create Outfit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save outfit' }));

    expect(screen.getByRole('dialog')).toHaveTextContent('Generate a look for Rainy Day?');
    expect(generateLook).not.toHaveBeenCalled();
  });

  it('cannot start a second generation while the first start is still settling', async () => {
    const { queryClient } = renderPage();
    let releaseInvalidations!: () => void;
    const invalidations = new Promise<void>((resolve) => {
      releaseInvalidations = resolve;
    });
    const invalidate = vi
      .spyOn(queryClient, 'invalidateQueries')
      .mockReturnValue(invalidations);

    fireEvent.click(screen.getByRole('button', { name: 'Generate look for Rainy Day' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate look (1 credit)' }));

    // The 202 has resolved while both invalidations are still in flight: the
    // exact window where the dialog used to re-enable and allow another charge.
    await waitFor(() => expect(generateLook).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));

    const confirm = screen.getByRole('button', { name: /Generate look \(1 credit\)|Starting\.\.\./ });

    // Clicking the confirm again here is the duplicate the dialog used to allow.
    fireEvent.click(confirm);

    expect(generateLook).toHaveBeenCalledTimes(1);
    expect(generateLook).toHaveBeenCalledWith({ data: { outfit_id: 'outfit-1' } });
    expect(confirm).toHaveTextContent('Starting...');
    expect(confirm).toBeDisabled();

    await act(async () => {
      releaseInvalidations();
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens the same 1-credit confirmation from onSaved in create mode', () => {
    mockOutfits({ outfits: [] });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Create Outfit' }));

    const props = createOutfitModal.props;
    expect(props?.outfit).toBeUndefined();
    const onSaved = props?.onSaved;
    expect(onSaved).toBeTypeOf('function');

    act(() => onSaved?.({ id: 'outfit-new', name: 'Sunny Day' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Generate a look for Sunny Day?');
    expect(dialog).toHaveTextContent('This uses 1 of your daily credits.');
    expect(generateLook).not.toHaveBeenCalled();
  });

  it('opens the same 1-credit confirmation from onSaved in edit mode', () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Rainy Day' }));

    const props = createOutfitModal.props;
    expect(props?.outfit).toMatchObject({ id: 'outfit-1', name: 'Rainy Day' });
    const onSaved = props?.onSaved;
    expect(onSaved).toBeTypeOf('function');

    act(() => onSaved?.({ id: 'outfit-1', name: 'Rainy Day Updated' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Generate a look for Rainy Day Updated?');
    expect(dialog).toHaveTextContent('This uses 1 of your daily credits.');
    expect(generateLook).not.toHaveBeenCalled();
  });
});

describe('WardrobePage dialog scroll lock', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    createOutfitModal.props = null;
    addItemModal.props = null;
    generateLook.mockReset();
    generateLook.mockResolvedValue({ generation_id: 'gen-2', outfit_id: 'outfit-1' });
    vi.mocked(useGetWardrobe).mockReturnValue({ data: [], isLoading: false } as any);
    vi.mocked(useGetWardrobeCategories).mockReturnValue({ data: { categories: [] } } as any);
    vi.mocked(useDeleteWardrobeItemsId).mockReturnValue({ mutate: vi.fn() } as any);
    vi.mocked(usePostVtoGenerations).mockReturnValue({ mutateAsync: generateLook, isPending: false } as any);
    mockOutfits(outfitResponse(outfit()));
    document.body.style.overflow = '';
  });

  afterEach(() => {
    cleanup();
    document.body.style.overflow = '';
    vi.clearAllMocks();
  });

  it('does not lock while the look dialog is mounted but closed', () => {
    renderPage();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('locks from the look dialog open until Cancel and rings both buttons', () => {
    renderPage();
    expect(document.body.style.overflow).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Generate look for Rainy Day' }));
    const dialog = screen.getByRole('dialog', { name: 'Generate a look for Rainy Day?' });
    expect(document.body.style.overflow).toBe('hidden');

    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirm = within(dialog).getByRole('button', { name: 'Generate look (1 credit)' });
    for (const button of [cancel, confirm]) {
      const tokens = button.className.split(/\s+/);
      expect(tokens).toContain('focus:ring-2');
      expect(tokens).toContain('focus:ring-indigo-500');
    }

    fireEvent.click(cancel);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('stays locked while the outfit dialog closes under the look dialog', () => {
    mockOutfits({ outfits: [] });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Create Outfit' }));
    const outfitDialog = screen.getByTestId('create-outfit-stand-in');
    expect(document.body.style.overflow).toBe('hidden');

    // The save opens the look confirmation before the outfit dialog closes: the
    // real CreateOutfitModal calls onSaved, then onClose.
    fireEvent.click(within(outfitDialog).getByRole('button', { name: 'Save outfit' }));
    const lookDialog = screen.getByRole('dialog', { name: 'Generate a look for Rainy Day?' });
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.click(within(outfitDialog).getByRole('button', { name: 'Close outfit' }));
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByRole('dialog', { name: 'Generate a look for Rainy Day?' })).toBeInTheDocument();

    fireEvent.click(within(lookDialog).getByRole('button', { name: 'Cancel' }));
    expect(document.body.style.overflow).toBe('');
  });
});

describe('WardrobePage item creation under a category filter', () => {
  const refetch = vi.fn();

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    createOutfitModal.props = null;
    addItemModal.props = null;
    refetch.mockReset();
    generateLook.mockReset();
    generateLook.mockResolvedValue({ generation_id: 'gen-2', outfit_id: 'outfit-1' });
    vi.mocked(useGetWardrobe).mockReturnValue({ data: [], isLoading: false, refetch } as any);
    vi.mocked(useGetWardrobeCategories).mockReturnValue({ data: { categories: ['Top', 'Bottom'] } } as any);
    vi.mocked(useDeleteWardrobeItemsId).mockReturnValue({ mutate: vi.fn() } as any);
    vi.mocked(usePostVtoGenerations).mockReturnValue({ mutateAsync: generateLook, isPending: false } as any);
    mockOutfits({ outfits: [] });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('clears an active category filter before refreshing, so the created item stays in front of the poll', () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Add Item' }));
    fireEvent.click(screen.getByRole('button', { name: 'Top' }));

    // The filter is active and the page's wardrobe query carries it.
    expect(screen.getByRole('button', { name: 'Top' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
    expect(vi.mocked(useGetWardrobe).mock.lastCall?.[0]).toEqual({ category: 'Top' });

    const props = addItemModal.props;
    expect(props?.onItemsCreated).toBeTypeOf('function');

    act(() => props?.onItemsCreated?.());

    // The Service creates the item with category 'pending', which the filter would
    // exclude, so the page clears the filter before refetching and polling.
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Top' })).toHaveAttribute('aria-pressed', 'false');
    expect(vi.mocked(useGetWardrobe).mock.lastCall?.[0]).toEqual({});
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
