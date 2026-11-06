// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import WardrobePage from './WardrobePage';
import { customInstance } from '../../api/custom-instance';
import { getGetWardrobeQueryKey } from '../../api/endpoints/wardrobe/wardrobe';
import type { GetWardrobe200Item } from '../../api/model/getWardrobe200Item';
import type { TaggingStatusResponse } from '../../api/model/taggingStatusResponse';

const LOOK_URL = 'https://anywear-beta.s3.amazonaws.com/outfit-generations/user-1/outfit-1/gen-1.png?X-Amz-Signature=signed';
const ITEM_URL = 'https://anywear-beta.s3.amazonaws.com/wardrobe/coat.jpg?X-Amz-Signature=signed';
const REFRESHED_URL = 'https://anywear-beta.s3.amazonaws.com/wardrobe/coat.jpg?X-Amz-Signature=refreshed';

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

interface SseConnectionMock {
  path: string;
  onEvent: (data: TaggingStatusResponse) => void;
  options: {
    eventName?: string;
    isTerminal?: (data: TaggingStatusResponse) => boolean;
    onStateChange?: (state: string) => void;
  };
  closed: boolean;
}

/** Every aggregate stream the page opened, in order. */
const sseStreams = vi.hoisted(() => ({
  connections: [] as SseConnectionMock[],
  /** Whether a new connection reports a successful open immediately. */
  autoOpen: true,
}));

vi.mock('../../lib/sse', () => ({
  connectSse: (
    path: string,
    onEvent: (data: TaggingStatusResponse) => void,
    options: SseConnectionMock['options'] = {},
  ) => {
    const connection: SseConnectionMock = { path, onEvent, options, closed: false };
    sseStreams.connections.push(connection);
    // The real connection reports `connecting` and then either `open` or, when
    // the attempt fails, `reconnecting` until a later attempt opens.
    options.onStateChange?.('connecting');
    if (sseStreams.autoOpen) options.onStateChange?.('open');
    return {
      close: () => {
        connection.closed = true;
        options.onStateChange?.('closed');
      },
    };
  },
}));

vi.mock('../../api/custom-instance', () => ({ customInstance: vi.fn() }));

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

import { useGetOutfits } from '../../api/endpoints/outfits/outfits';
import { usePostVtoGenerations } from '../../api/endpoints/vto/vto';

const generateLook = vi.fn();
const customInstanceMock = vi.mocked(customInstance);

/** The list the mocked Service answers `GET /wardrobe` with. */
let wardrobeItems: GetWardrobe200Item[] = [];
/** When set, the next wardrobe reads answer through it instead of `wardrobeItems`. */
let wardrobeHandler: ((items: GetWardrobe200Item[]) => Promise<GetWardrobe200Item[]>) | null = null;
let defaultCategories: string[] = [];

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

function wardrobeItem(overrides: Partial<GetWardrobe200Item> = {}): GetWardrobe200Item {
  return {
    id: 'item-1',
    ownerId: 'user-1',
    name: 'Coat',
    images: [{ imageId: 'image-1', url: ITEM_URL, view: null, isPrimary: true }],
    category: 'Outerwear',
    taggingStatus: 'ready',
    taggingStateVersion: 1,
    taggingErrorCode: null,
    taggingErrorMessage: null,
    weatherTags: null,
    styleAttributes: null,
    isPublic: false,
    imageEmbedding: null,
    createdAt: '2026-05-05T00:00:00.000Z',
    updatedAt: '2026-05-05T00:00:00.000Z',
    ...overrides,
  };
}

function statusFrame(overrides: Partial<TaggingStatusResponse> = {}): TaggingStatusResponse {
  return {
    item_id: 'item-1',
    tagging_status: 'ready',
    state_version: 2,
    style_attributes: { color: 'Blue', material: 'Cotton' },
    weather_tags: ['Cold'],
    error_message: null,
    images: [{ imageId: 'image-1', url: REFRESHED_URL, view: null, isPrimary: true }],
    ...overrides,
  };
}

function wardrobeRequests(): Array<Record<string, any>> {
  return customInstanceMock.mock.calls
    .map(([config]) => config as unknown as Record<string, any>)
    .filter((config) => config.method === 'GET' && config.url === '/wardrobe');
}

function wardrobeCache(): GetWardrobe200Item[] | undefined {
  return queryClients[queryClients.length - 1]?.getQueryData<GetWardrobe200Item[]>(getGetWardrobeQueryKey({}));
}

const queryClients: QueryClient[] = [];

function renderPage(options: { seed?: GetWardrobe200Item[]; categories?: string[] } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // A seeded page is already authoritative, so the test starts from a
        // settled render; a page under test reads on mount and on triggers.
        staleTime: options.seed ? Infinity : 0,
      },
    },
  });
  if (options.seed) {
    queryClient.setQueryData(getGetWardrobeQueryKey({}), options.seed);
    queryClient.setQueryData(['/wardrobe/categories'], { categories: options.categories ?? [] });
  }
  queryClients.push(queryClient);
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

/** Opens the mocked Add Item dialog so its page wiring can be invoked. */
function openAddItemDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Add Item' }));
  const props = addItemModal.props;
  expect(props?.onItemsCreated).toBeTypeOf('function');
  return props!;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Delivers status frames and lets React Query's batched cache notification
 * reach the page before the assertions run.
 */
async function pushFrames(connection: SseConnectionMock, frames: TaggingStatusResponse[]) {
  await act(async () => {
    for (const frame of frames) connection.onEvent(frame);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  createOutfitModal.props = null;
  addItemModal.props = null;
  sseStreams.connections.splice(0);
  sseStreams.autoOpen = true;
  queryClients.splice(0).forEach((client) => client.clear());
  wardrobeItems = [];
  wardrobeHandler = null;
  defaultCategories = [];
  generateLook.mockReset();
  generateLook.mockResolvedValue({ generation_id: 'gen-2', outfit_id: 'outfit-1' });

  customInstanceMock.mockReset();
  customInstanceMock.mockImplementation(((config: Record<string, any>) => {
    if (config.method === 'GET' && config.url === '/wardrobe') {
      const category = config.params?.category;
      const matching = category ? wardrobeItems.filter((item) => item.category === category) : wardrobeItems;
      return wardrobeHandler ? wardrobeHandler(matching) : Promise.resolve(matching);
    }
    if (config.method === 'GET' && config.url === '/wardrobe/categories') {
      return Promise.resolve({ categories: defaultCategories });
    }
    return Promise.resolve(undefined);
  }) as any);

  vi.mocked(usePostVtoGenerations).mockReturnValue({ mutateAsync: generateLook, isPending: false } as any);
  mockOutfits(outfitResponse(outfit()));
  document.body.style.overflow = '';
});

afterEach(() => {
  cleanup();
  queryClients.splice(0).forEach((client) => client.clear());
  document.body.style.overflow = '';
  vi.clearAllMocks();
});

describe('WardrobePage saved outfit look cards', () => {
  it('renders the completed look URL with a cache key that names its generation', () => {
    mockOutfits(outfitResponse(outfit({
      latestGeneration: { id: 'gen-1', status: 'Complete', errorCode: null, createdAt: '2026-06-01T00:00:00.000Z' },
      look: { generationId: 'gen-1', url: LOOK_URL, createdAt: '2026-06-01T00:00:00.000Z' },
    })));

    renderPage({ seed: [] });

    const image = screen.getByTestId('outfit-thumbnail-outfit-1');
    expect(image).toHaveAttribute('src', LOOK_URL);
    expect(image).toHaveAttribute('data-cache-key', 'outfit-look-gen-1');
    expect(screen.queryByTestId('outfit-look-badge-pending')).toBeNull();
    expect(screen.getByRole('button', { name: 'New look for Rainy Day' })).toBeInTheDocument();
  });

  it('never derives the image from wearable items: no look shows the empty state and Generate look', () => {
    renderPage({ seed: [] });

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

    renderPage({ seed: [] });

    expect(screen.getByTestId('outfit-look-badge-pending')).toHaveTextContent('Pending');
    expect(screen.getByText('Generating look...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Generate look for/ })).toBeNull();
  });

  it('shows Processing as a live state without an action', () => {
    mockOutfits(outfitResponse(outfit({
      latestGeneration: { id: 'gen-2', status: 'Processing', errorCode: null, createdAt: '2026-06-02T00:00:00.000Z' },
    })));

    renderPage({ seed: [] });

    expect(screen.getByTestId('outfit-look-badge-processing')).toHaveTextContent('Processing');
    expect(screen.queryByRole('button', { name: /Generate look for/ })).toBeNull();
  });

  it('shows Failed with Retry while keeping the older completed look', () => {
    mockOutfits(outfitResponse(outfit({
      latestGeneration: { id: 'gen-2', status: 'Failed', errorCode: 'base_photo_unavailable', createdAt: '2026-06-02T00:00:00.000Z' },
      look: { generationId: 'gen-1', url: LOOK_URL, createdAt: '2026-06-01T00:00:00.000Z' },
    })));

    renderPage({ seed: [] });

    expect(screen.getByTestId('outfit-look-badge-failed')).toHaveTextContent('Failed');
    expect(screen.getByTestId('outfit-thumbnail-outfit-1')).toHaveAttribute('src', LOOK_URL);
    expect(screen.getByRole('button', { name: 'Retry for Rainy Day' })).toBeInTheDocument();
  });

  it('starts nothing on load; Cancel in the confirmation spends nothing', async () => {
    renderPage({ seed: [] });

    expect(generateLook).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Generate look for Rainy Day' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('This uses 1 of your daily credits.');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(generateLook).not.toHaveBeenCalled();
  });

  it('confirms a generation without base_photo_id and refreshes the outfits and user queries', async () => {
    const { queryClient } = renderPage({ seed: [] });
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
    renderPage({ seed: [] });

    fireEvent.click(screen.getByRole('button', { name: 'Generate look for Rainy Day' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate look (1 credit)' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Daily AI credits exhausted. Resets tomorrow.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('offers the same confirmed action after saving an outfit', async () => {
    mockOutfits({ outfits: [] });
    renderPage({ seed: [] });

    fireEvent.click(screen.getByRole('button', { name: 'Create Outfit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save outfit' }));

    expect(screen.getByRole('dialog')).toHaveTextContent('Generate a look for Rainy Day?');
    expect(generateLook).not.toHaveBeenCalled();
  });

  it('cannot start a second generation while the first start is still settling', async () => {
    const { queryClient } = renderPage({ seed: [] });
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
    renderPage({ seed: [] });

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
    renderPage({ seed: [] });

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
  it('does not lock while the look dialog is mounted but closed', () => {
    renderPage({ seed: [] });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('locks from the look dialog open until Cancel and rings both buttons', () => {
    renderPage({ seed: [] });
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
    renderPage({ seed: [] });

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
  it('clears an active category filter before refreshing, so the created item reaches the next list read', async () => {
    defaultCategories = ['Top', 'Bottom'];
    renderPage();

    const topFilter = await screen.findByRole('button', { name: 'Top' });
    fireEvent.click(topFilter);
    await waitFor(() => expect(wardrobeRequests().some((config) => config.params?.category === 'Top')).toBe(true));

    const props = openAddItemDialog();
    const topRequestIndex = wardrobeRequests().findIndex((config) => config.params?.category === 'Top');

    act(() => props.onItemsCreated?.());

    // The filter is cleared before the refresh, so the created 'pending' item is
    // not excluded by the category the page was showing.
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Top' })).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => {
      const later = wardrobeRequests().slice(topRequestIndex + 1);
      expect(later.some((config) => Object.keys(config.params ?? {}).length === 0)).toBe(true);
    });
  });
});

describe('WardrobePage aggregate status stream', () => {
  function fiftyProcessingItems(): GetWardrobe200Item[] {
    return Array.from({ length: 50 }, (_, index) => wardrobeItem({
      id: `item-${index}`,
      name: `Item ${index}`,
      taggingStatus: 'processing',
      taggingStateVersion: 1,
    }));
  }

  it('opens exactly one aggregate stream for fifty processing items and no per-item stream', async () => {
    wardrobeItems = fiftyProcessingItems();
    renderPage();

    await waitFor(() => expect(sseStreams.connections).toHaveLength(1));

    expect(sseStreams.connections[0].path).toBe('/wardrobe/status/stream');
    expect(sseStreams.connections[0].options.eventName).toBe('status');
    // A terminal frame must not close the aggregate stream by itself.
    expect(sseStreams.connections[0].options.isTerminal).toBeUndefined();
    expect(sseStreams.connections.filter((connection) => connection.path !== '/wardrobe/status/stream')).toEqual([]);
    expect(sseStreams.connections).toHaveLength(1);
  });

  it('does not reopen the stream when the list is refetched', async () => {
    wardrobeItems = fiftyProcessingItems();
    renderPage();
    await waitFor(() => expect(sseStreams.connections).toHaveLength(1));

    const requestsBefore = wardrobeRequests().length;
    const props = openAddItemDialog();
    act(() => props.onItemsCreated?.());

    await waitFor(() => expect(wardrobeRequests().length).toBe(requestsBefore + 1));
    expect(sseStreams.connections).toHaveLength(1);
  });

  it('applies fifty frames through the cache and never invalidates the wardrobe list', async () => {
    wardrobeItems = fiftyProcessingItems();
    const { queryClient } = renderPage();
    await waitFor(() => expect(sseStreams.connections).toHaveLength(1));

    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const connection = sseStreams.connections[0];

    await pushFrames(connection, Array.from({ length: 50 }, (_, index) => statusFrame({
      item_id: `item-${index}`,
      tagging_status: 'ready',
      state_version: 2,
      style_attributes: { color: 'Blue', material: 'Cotton' },
      weather_tags: ['Cold'],
      images: [{ imageId: 'image-1', url: REFRESHED_URL, view: null, isPrimary: true }],
    })));

    expect(invalidate.mock.calls.filter(([arg]) => String(arg?.queryKey?.[0] ?? '') === '/wardrobe')).toEqual([]);
    expect(screen.queryAllByText('Analyzing...')).toHaveLength(0);

    const cached = wardrobeCache() ?? [];
    expect(cached).toHaveLength(50);
    const updated = cached.find((item) => item.id === 'item-0')!;
    expect(updated).toMatchObject({
      taggingStatus: 'ready',
      taggingStateVersion: 2,
      styleAttributes: { color: 'Blue', material: 'Cotton' },
      weatherTags: ['Cold'],
      taggingErrorMessage: null,
      images: [{ imageId: 'image-1', url: REFRESHED_URL, view: null, isPrimary: true }],
    });
    // Only the frame-owned fields move; the last list read still owns the rest.
    expect(updated.category).toBe('Outerwear');
    expect(updated.name).toBe('Item 0');
    expect(updated.taggingErrorCode).toBeNull();

    // Every item is settled now, so the stream closes because nothing is in
    // flight, not because a frame was terminal.
    await waitFor(() => expect(connection.closed).toBe(true));
  });

  it('keeps the aggregate stream open after one terminal frame while another item is in flight', async () => {
    wardrobeItems = [
      wardrobeItem({ id: 'item-a', name: 'Still going', taggingStatus: 'processing' }),
      wardrobeItem({ id: 'item-b', name: 'Finishing', taggingStatus: 'processing' }),
    ];
    renderPage();
    await waitFor(() => expect(sseStreams.connections).toHaveLength(1));
    const connection = sseStreams.connections[0];

    act(() => connection.onEvent(statusFrame({ item_id: 'item-b', tagging_status: 'ready', state_version: 2 })));
    await flush();
    expect(connection.closed).toBe(false);
    expect(screen.getAllByText('Analyzing...')).toHaveLength(1);

    act(() => connection.onEvent(statusFrame({ item_id: 'item-a', tagging_status: 'failed', state_version: 3, error_message: 'model_error' })));
    await flush();
    expect(connection.closed).toBe(true);
    expect(screen.queryAllByText('Analyzing...')).toHaveLength(0);
  });

  it('ignores an out-of-order frame that arrives after a terminal one', async () => {
    wardrobeItems = [wardrobeItem({ id: 'item-1', name: 'Coat', taggingStatus: 'processing', taggingStateVersion: 1 })];
    renderPage();
    await waitFor(() => expect(sseStreams.connections).toHaveLength(1));
    const connection = sseStreams.connections[0];

    act(() => connection.onEvent(statusFrame({ tagging_status: 'failed', state_version: 3, error_message: 'provider_error' })));
    await flush();
    expect(screen.getByText('Failed')).toBeInTheDocument();

    act(() => connection.onEvent(statusFrame({ tagging_status: 'processing', state_version: 2 })));
    await flush();

    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(wardrobeCache()?.[0]).toMatchObject({ taggingStatus: 'failed', taggingStateVersion: 3 });
  });

  it('keeps a filtered list to its own items when a frame names another item', async () => {
    defaultCategories = ['Top', 'Bottom'];
    wardrobeItems = [
      wardrobeItem({ id: 'top-1', name: 'My T-Shirt', category: 'Top', taggingStatus: 'processing', taggingStateVersion: 1 }),
      wardrobeItem({ id: 'bottom-1', name: 'My Jeans', category: 'Bottom', taggingStatus: 'processing', taggingStateVersion: 1 }),
    ];
    const { queryClient } = renderPage();
    await waitFor(() => expect(sseStreams.connections).toHaveLength(1));

    fireEvent.click(await screen.findByRole('button', { name: 'Top' }));
    await waitFor(() => expect(queryClient.getQueryData(getGetWardrobeQueryKey({ category: 'Top' }))).toBeDefined());
    expect(screen.queryByText('My Jeans')).toBeNull();

    await pushFrames(sseStreams.connections[0], [statusFrame({
      item_id: 'bottom-1',
      tagging_status: 'ready',
      state_version: 2,
    })]);

    const filtered = queryClient.getQueryData<GetWardrobe200Item[]>(getGetWardrobeQueryKey({ category: 'Top' })) ?? [];
    expect(filtered.map((item) => item.id)).toEqual(['top-1']);
    // The frame still reaches the unfiltered list, which does contain the item.
    const all = queryClient.getQueryData<GetWardrobe200Item[]>(getGetWardrobeQueryKey({})) ?? [];
    expect(all.find((item) => item.id === 'bottom-1')).toMatchObject({ taggingStatus: 'ready', taggingStateVersion: 2 });
  });

  it('keeps the newer item when a stale list response resolves after a frame', async () => {
    wardrobeItems = [wardrobeItem({ id: 'item-1', name: 'Coat', taggingStatus: 'processing', taggingStateVersion: 1 })];
    const { queryClient } = renderPage();
    await waitFor(() => expect(sseStreams.connections).toHaveLength(1));

    let release!: (items: GetWardrobe200Item[]) => void;
    const gate = new Promise<GetWardrobe200Item[]>((resolve) => {
      release = resolve;
    });
    let handled = 0;
    wardrobeHandler = () => {
      handled += 1;
      return gate;
    };

    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(handled).toBe(1));

    // The newer frame lands while the list read is in flight.
    await pushFrames(sseStreams.connections[0], [statusFrame({
      item_id: 'item-1',
      tagging_status: 'ready',
      state_version: 3,
      style_attributes: { color: 'Blue', material: 'Cotton' },
    })]);
    expect(screen.getByText('Blue • Cotton')).toBeInTheDocument();

    // The response started before the frame resolves with the older item.
    await act(async () => {
      release([wardrobeItem({ id: 'item-1', name: 'Coat', taggingStatus: 'processing', taggingStateVersion: 1 })]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    wardrobeHandler = null;

    expect(screen.getByText('Blue • Cotton')).toBeInTheDocument();
    expect(screen.queryByText('Analyzing...')).toBeNull();
    expect(queryClient.getQueryData<GetWardrobe200Item[]>(getGetWardrobeQueryKey({}))?.[0]).toMatchObject({
      taggingStatus: 'ready',
      taggingStateVersion: 3,
    });
  });

  it('reads the merged list once per recovery trigger and one trailing read for overlapping triggers', async () => {
    wardrobeItems = fiftyProcessingItems();
    renderPage();
    await waitFor(() => expect(wardrobeRequests()).toHaveLength(1));
    await waitFor(() => expect(sseStreams.connections).toHaveLength(1));
    const connection = sseStreams.connections[0];

    /** Fires one recovery trigger and proves it added exactly one list read. */
    const triggerOnce = async (label: string, trigger: () => void) => {
      const before = wardrobeRequests().length;
      trigger();
      await waitFor(() => expect(
        wardrobeRequests().length,
        `${label}: one read after ${before}`,
      ).toBe(before + 1));
      // Let the read settle so the next trigger starts its own read.
      await flush();
    };

    // Stream reopened after a reconnect.
    await triggerOnce('reopen', () => {
      connection.options.onStateChange?.('reconnecting');
      connection.options.onStateChange?.('open');
    });

    // Document visible again.
    await triggerOnce('visibility', () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Network recovered.
    await triggerOnce('online', () => {
      window.dispatchEvent(new Event('online'));
    });

    // App resumed / OS window focused.
    await triggerOnce('focus', () => {
      window.dispatchEvent(new Event('focus'));
    });

    // Triggers while one read is in flight collapse into that read plus exactly
    // one trailing read; nothing overlaps the trailing read, so it is the last.
    let releaseLeading!: (items: GetWardrobe200Item[]) => void;
    let releaseTrailing!: (items: GetWardrobe200Item[]) => void;
    let reads = 0;
    wardrobeHandler = () => {
      reads += 1;
      if (reads === 1) {
        return new Promise<GetWardrobe200Item[]>((resolve) => { releaseLeading = resolve; });
      }
      if (reads === 2) {
        return new Promise<GetWardrobe200Item[]>((resolve) => { releaseTrailing = resolve; });
      }
      return Promise.resolve(wardrobeItems);
    };

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('online'));
    });
    await flush();
    expect(reads).toBe(1);

    act(() => { window.dispatchEvent(new Event('focus')); });
    await flush();
    expect(reads).toBe(1);

    await act(async () => {
      releaseLeading(wardrobeItems);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(reads).toBe(2);

    await act(async () => {
      releaseTrailing(wardrobeItems);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(reads).toBe(2);
    wardrobeHandler = null;
  });

  it('re-reads the list when the first stream open follows failed attempts', async () => {
    sseStreams.autoOpen = false;
    wardrobeItems = [wardrobeItem({ id: 'item-1', taggingStatus: 'processing', taggingStateVersion: 1 })];
    renderPage();
    await waitFor(() => expect(sseStreams.connections).toHaveLength(1));
    const connection = sseStreams.connections[0];
    const before = wardrobeRequests().length;

    // The first attempt never opens: the connection drops into `reconnecting`
    // and the list may have moved on while no stream was live.
    act(() => connection.options.onStateChange?.('reconnecting'));
    act(() => connection.options.onStateChange?.('open'));

    await waitFor(() => expect(wardrobeRequests().length).toBe(before + 1));
    await flush();
    expect(wardrobeRequests().length).toBe(before + 1);
  });

  it('schedules no list interval while items are processing', async () => {
    vi.useFakeTimers();
    try {
      renderPage({
        seed: [wardrobeItem({ id: 'item-1', taggingStatus: 'processing', taggingStateVersion: 1 })],
      });
      expect(sseStreams.connections).toHaveLength(1);
      expect(wardrobeRequests()).toHaveLength(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(wardrobeRequests()).toHaveLength(0);
      expect(sseStreams.connections).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WardrobePage list reads after confirmations', () => {
  it('runs one trailing read when a second confirmation commits during a read', async () => {
    renderPage();
    await waitFor(() => expect(wardrobeRequests()).toHaveLength(1));
    const requestsAfterMount = wardrobeRequests().length;

    const props = openAddItemDialog();
    let releaseLeading!: (items: GetWardrobe200Item[]) => void;
    let reads = 0;
    wardrobeHandler = () => {
      reads += 1;
      if (reads === 1) {
        return new Promise<GetWardrobe200Item[]>((resolve) => { releaseLeading = resolve; });
      }
      return Promise.resolve(wardrobeItems);
    };

    // Confirmation #1 refreshes the list; its read is still in flight.
    act(() => props.onItemsCreated?.());
    await flush();
    expect(reads).toBe(1);

    // Confirmation #2 commits while that read is in flight. Its refresh joins
    // the read whose snapshot predates #2, so item 2 is not in that response.
    wardrobeItems = [
      wardrobeItem({ id: 'item-1', name: 'Item 1', taggingStatus: 'processing' }),
      wardrobeItem({ id: 'item-2', name: 'Item 2', taggingStatus: 'processing' }),
    ];
    act(() => props.onItemsCreated?.());
    await flush();
    expect(reads).toBe(1);

    await act(async () => {
      // The leading read answers with the pre-#2 snapshot: only item 1.
      releaseLeading([wardrobeItem({ id: 'item-1', name: 'Item 1', taggingStatus: 'processing' })]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Exactly one trailing read runs after the leading one settles, and it sees
    // both confirmed items.
    await waitFor(() => expect(reads).toBe(2));
    await flush();
    expect(reads).toBe(2);
    expect(wardrobeRequests().length).toBe(requestsAfterMount + 2);
    await waitFor(() => expect(screen.getByText('Item 2')).toBeInTheDocument());
    expect(screen.getByText('Item 1')).toBeInTheDocument();
    wardrobeHandler = null;
  });

  it('runs no trailing read when nothing overlaps the read', async () => {
    renderPage();
    await waitFor(() => expect(wardrobeRequests()).toHaveLength(1));
    const props = openAddItemDialog();

    let reads = 0;
    wardrobeHandler = () => {
      reads += 1;
      return Promise.resolve(wardrobeItems);
    };

    act(() => props.onItemsCreated?.());
    await waitFor(() => expect(reads).toBe(1));
    // The read settled before the next trigger, so there is nothing to trail.
    await flush();
    expect(reads).toBe(1);

    act(() => props.onItemsCreated?.());
    await waitFor(() => expect(reads).toBe(2));
    await flush();
    expect(reads).toBe(2);
    expect(wardrobeRequests()).toHaveLength(3);
    wardrobeHandler = null;
  });
});
