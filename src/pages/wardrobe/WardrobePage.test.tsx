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
  onSuccess?: () => Promise<unknown> | void;
  onSaved?: (outfit: { id: string; name?: string | null }) => void;
  onNotice?: (notice: { retainedObjectKeys: number }) => void;
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

interface ItemDetailsModalMockProps {
  item: GetWardrobe200Item;
  isOpen: boolean;
  onClose?: () => void;
  onSuccess?: () => void;
  onDeleted?: (outcome: 'deleted' | 'already-gone') => void;
  onRetagStarted?: () => void;
}

const itemDetailsModal = vi.hoisted(() => ({
  props: null as ItemDetailsModalMockProps | null,
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
vi.mock('./ItemDetailsModal', () => ({
  default: (props: ItemDetailsModalMockProps) => {
    // Record the real props so the tests can drive the page's own wiring for the
    // delete and re-tag outcomes instead of relying on this stand-in.
    itemDetailsModal.props = props;
    return null;
  },
}));
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
/** The mocked `DELETE /wardrobe/items/{id}`; a test replaces it with its own outcome. */
let deleteHandler: (config: Record<string, any>) => Promise<unknown> = () => Promise.resolve({});
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
    archivedAt: null,
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

/** Every `DELETE /wardrobe/items/{id}` the page's confirmation issued. */
function deleteRequests(): Array<Record<string, any>> {
  return customInstanceMock.mock.calls
    .map(([config]) => config as unknown as Record<string, any>)
    .filter((config) => config.method === 'DELETE');
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

/**
 * Opens the mocked item details dialog so the page's own delete and re-tag
 * wiring can be invoked.
 */
function openItemDetailsDialog(itemName = 'Coat') {
  fireEvent.click(screen.getByRole('button', { name: `View ${itemName} details` }));
  const props = itemDetailsModal.props;
  expect(props?.onDeleted).toBeTypeOf('function');
  expect(props?.onRetagStarted).toBeTypeOf('function');
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
  itemDetailsModal.props = null;
  sseStreams.connections.splice(0);
  sseStreams.autoOpen = true;
  queryClients.splice(0).forEach((client) => client.clear());
  wardrobeItems = [];
  wardrobeHandler = null;
  deleteHandler = () => Promise.resolve({});
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
    if (config.method === 'DELETE' && typeof config.url === 'string' && config.url.startsWith('/wardrobe/items/')) {
      return deleteHandler(config);
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

  it('renders an unnamed outfit as Untitled Outfit and a Service-derived name verbatim', () => {
    mockOutfits({
      outfits: [
        outfit({ id: 'outfit-unnamed', name: null, wearableItems: [] }),
        outfit({
          id: 'outfit-derived',
          name: 'T-Shirt, Jeans',
          wearableItems: [
            { id: 'item-1', name: 'T-Shirt', category: 'Top', images: [] },
            { id: 'item-2', name: 'Jeans', category: 'Bottom', images: [] },
          ],
        }),
      ],
    });

    renderPage({ seed: [] });

    // A null name keeps the page's own fallback, and its only edit control names
    // that fallback rather than an absent string.
    expect(screen.getByRole('heading', { name: 'Untitled Outfit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit outfit' })).toBeInTheDocument();
    // A derived name comes from the Service and is shown exactly as returned.
    expect(screen.getByRole('heading', { name: 'T-Shirt, Jeans' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit T-Shirt, Jeans' })).toBeInTheDocument();
  });

  it('never derives the image from wearable items: no generation shows No look yet and Generate look', () => {
    renderPage({ seed: [] });

    expect(screen.queryByTestId('outfit-thumbnail-outfit-1')).toBeNull();
    expect(screen.getByText('No look yet')).toBeInTheDocument();
    expect(document.querySelector(`img[src="${ITEM_URL}"]`)).toBeNull();
    expect(screen.getByRole('button', { name: 'Generate look for Rainy Day' })).toBeInTheDocument();
    expect(screen.getByText('1 items')).toBeInTheDocument();
    // An empty outfit paints the text placeholder, never the running skeleton.
    expect(screen.queryByTestId('outfit-cover-skeleton-outfit-1')).toBeNull();
  });

  it('shows Pending as a skeleton with aria-busy and offers no second action while it is active', () => {
    mockOutfits(outfitResponse(outfit({
      latestGeneration: { id: 'gen-2', status: 'Pending', errorCode: null, createdAt: '2026-06-02T00:00:00.000Z' },
    })));

    renderPage({ seed: [] });

    expect(screen.getByTestId('outfit-look-badge-pending')).toHaveTextContent('Pending');
    const skeleton = screen.getByTestId('outfit-cover-skeleton-outfit-1');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(skeleton).toHaveClass('animate-pulse');
    expect(screen.getByText('Generating…')).toBeInTheDocument();
    expect(screen.queryByText('Generating look...')).toBeNull();
    expect(screen.queryByText('No look yet')).toBeNull();
    expect(screen.queryByRole('button', { name: /Generate look for|New look for|Retry for/ })).toBeNull();
  });

  it('shows Processing as a skeleton without an action', () => {
    mockOutfits(outfitResponse(outfit({
      latestGeneration: { id: 'gen-2', status: 'Processing', errorCode: null, createdAt: '2026-06-02T00:00:00.000Z' },
    })));

    renderPage({ seed: [] });

    expect(screen.getByTestId('outfit-look-badge-processing')).toHaveTextContent('Processing');
    expect(screen.getByTestId('outfit-cover-skeleton-outfit-1')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Generating…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Generate look for/ })).toBeNull();
  });

  it('shows Last try-on failed and Retry when the last generation failed with no look', () => {
    mockOutfits(outfitResponse(outfit({
      latestGeneration: { id: 'gen-2', status: 'Failed', errorCode: 'base_photo_unavailable', createdAt: '2026-06-02T00:00:00.000Z' },
    })));

    renderPage({ seed: [] });

    expect(screen.getByText('Last try-on failed')).toBeInTheDocument();
    expect(screen.queryByText('No look yet')).toBeNull();
    expect(screen.queryByTestId('outfit-cover-skeleton-outfit-1')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry for Rainy Day' })).toBeInTheDocument();
  });

  it('shows Image unavailable and New look when a completed look has no signed url', () => {
    mockOutfits(outfitResponse(outfit({
      latestGeneration: { id: 'gen-1', status: 'Complete', errorCode: null, createdAt: '2026-06-01T00:00:00.000Z' },
      look: { generationId: 'gen-1', url: null, createdAt: '2026-06-01T00:00:00.000Z' },
    })));

    renderPage({ seed: [] });

    expect(screen.getByText('Image unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No look yet')).toBeNull();
    expect(screen.queryByTestId('outfit-thumbnail-outfit-1')).toBeNull();
    expect(screen.getByRole('button', { name: 'New look for Rainy Day' })).toBeInTheDocument();
  });

  it('paints the running skeleton instead of Image unavailable while a generation is active', () => {
    mockOutfits(outfitResponse(outfit({
      latestGeneration: { id: 'gen-2', status: 'Processing', errorCode: null, createdAt: '2026-06-02T00:00:00.000Z' },
      look: { generationId: 'gen-1', url: null, createdAt: '2026-06-01T00:00:00.000Z' },
    })));

    renderPage({ seed: [] });

    expect(screen.getByTestId('outfit-cover-skeleton-outfit-1')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('Image unavailable')).toBeNull();
    expect(screen.queryByText('No look yet')).toBeNull();
    expect(screen.queryByRole('button', { name: /New look for|Generate look for/ })).toBeNull();
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

describe('WardrobePage outfit cleanup notice', () => {
  /**
   * Issue 334 — a completed outfit delete no longer produces a "still cleaning up"
   * notice, because the route deletes no object: only the outfit row goes, and its
   * looks stay in the history. What the page owes after that delete is one refresh
   * of the outfits list so the card leaves.
   */
  it('refreshes the outfits list when the dialog reports a completed delete', async () => {
    renderPage({ seed: [] });

    await act(async () => {
      await createOutfitModal.props?.onSuccess?.();
    });

    // The page invalidates the outfits query; the list read it triggers is the
    // observable effect, and no cleanup notice is painted.
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('paints no "still cleaning up" notice, because nothing is deleted but the row', () => {
    renderPage({ seed: [] });
    expect(screen.queryByText(/still being cleaned up/)).toBeNull();
  });});

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

  it('reads the list once on a terminal frame so the generated name reaches the card', async () => {
    wardrobeItems = [wardrobeItem({
      id: 'item-1',
      name: null,
      category: '',
      taggingStatus: 'processing',
      taggingStateVersion: 1,
    })];
    renderPage();
    await waitFor(() => expect(wardrobeRequests()).toHaveLength(1));
    await waitFor(() => expect(sseStreams.connections).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'View wardrobe item details' })).toBeInTheDocument();

    // The terminal frame is emitted at the version that wrote the generated name
    // and category, but carries neither; the one-shot read must bring them.
    wardrobeItems = [wardrobeItem({
      id: 'item-1',
      name: 'Prada Argyle Short-Sleeve Knit Sweater',
      category: 'Top',
      taggingStatus: 'ready',
      taggingStateVersion: 2,
    })];

    await pushFrames(sseStreams.connections[0], [statusFrame({
      item_id: 'item-1',
      tagging_status: 'ready',
      state_version: 2,
    })]);

    await waitFor(() => expect(wardrobeRequests()).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole('button', {
      name: 'View Prada Argyle Short-Sleeve Knit Sweater details',
    })).toBeInTheDocument());
    // One terminal frame, exactly one merged read.
    await flush();
    expect(wardrobeRequests()).toHaveLength(2);
  });

  it('does not read again for a duplicate terminal frame at the same version', async () => {
    wardrobeItems = [wardrobeItem({
      id: 'item-1',
      name: null,
      category: '',
      taggingStatus: 'processing',
      taggingStateVersion: 1,
    })];
    renderPage();
    await waitFor(() => expect(sseStreams.connections).toHaveLength(1));
    const connection = sseStreams.connections[0];

    wardrobeItems = [wardrobeItem({
      id: 'item-1',
      name: 'Generated Name',
      category: 'Top',
      taggingStatus: 'ready',
      taggingStateVersion: 2,
    })];
    await pushFrames(connection, [statusFrame({ item_id: 'item-1', tagging_status: 'ready', state_version: 2 })]);
    await waitFor(() => expect(wardrobeRequests()).toHaveLength(2));
    await flush();

    // A replayed terminal frame at the same version adds nothing and reads nothing.
    await pushFrames(connection, [statusFrame({ item_id: 'item-1', tagging_status: 'ready', state_version: 2 })]);
    await flush();
    expect(wardrobeRequests()).toHaveLength(2);
  });

  it('does not read the list for a non-terminal frame', async () => {
    wardrobeItems = [wardrobeItem({
      id: 'item-1',
      name: null,
      category: '',
      taggingStatus: 'processing',
      taggingStateVersion: 1,
    })];
    renderPage();
    await waitFor(() => expect(sseStreams.connections).toHaveLength(1));
    const requestsBeforeFrame = wardrobeRequests().length;

    await pushFrames(sseStreams.connections[0], [statusFrame({
      item_id: 'item-1',
      tagging_status: 'processing',
      state_version: 2,
      style_attributes: { color: 'Blue', material: 'Cotton' },
    })]);

    await flush();
    expect(wardrobeRequests()).toHaveLength(requestsBeforeFrame);
    // The non-terminal frame still merges in place.
    expect(screen.getByText('Blue • Cotton')).toBeInTheDocument();
  });

  it('collapses two terminal frames into one leading and one trailing read', async () => {
    wardrobeItems = [
      wardrobeItem({ id: 'item-a', name: null, category: '', taggingStatus: 'processing', taggingStateVersion: 1 }),
      wardrobeItem({ id: 'item-b', name: null, category: '', taggingStatus: 'processing', taggingStateVersion: 1 }),
    ];
    renderPage();
    await waitFor(() => expect(sseStreams.connections).toHaveLength(1));
    const requestsBeforeFrames = wardrobeRequests().length;

    await pushFrames(sseStreams.connections[0], [
      statusFrame({ item_id: 'item-a', tagging_status: 'ready', state_version: 2 }),
      statusFrame({ item_id: 'item-b', tagging_status: 'failed', state_version: 2 }),
    ]);

    // The first frame starts the read; the second arrives while it is in flight
    // and joins its one trailing read instead of adding a third.
    await waitFor(() => expect(wardrobeRequests().length).toBe(requestsBeforeFrames + 2));
    await flush();
    expect(wardrobeRequests().length).toBe(requestsBeforeFrames + 2);
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

/**
 * Issue 332/334 — the item delete is reachable only from the Storage Box.
 *
 * The active view offers Archive; the Storage Box offers Restore and the
 * permanent Delete, and that delete renders from `dependent-outfits`: it lists
 * every outfit that goes, cannot confirm until the preview matches the exact
 * `total`, and is disabled outright while any of them has a running try-on.
 */
describe('WardrobePage Storage Box lifecycle', () => {
  /** The dependent-outfits preview the mocked Service answers. */
  let dependentOutfits: { total: number; outfits: Array<Record<string, unknown>> } = { total: 0, outfits: [] };
  let dependentOutfitsFails = false;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dependentOutfits = { total: 0, outfits: [] };
    dependentOutfitsFails = false;
    const base = customInstanceMock.getMockImplementation()!;
    customInstanceMock.mockImplementation(((config: Record<string, any>) => {
      if (config.method === 'GET' && typeof config.url === 'string'
        && config.url.endsWith('/dependent-outfits')) {
        if (dependentOutfitsFails) return Promise.reject({ response: { status: 503 } });
        return Promise.resolve(dependentOutfits);
      }
      return base(config);
    }) as any);
  });

  function archivedItem(overrides: Partial<GetWardrobe200Item> = {}) {
    return wardrobeItem({ archivedAt: '2026-03-01T09:00:00.000Z', ...overrides });
  }

  async function openStorageBox(items: GetWardrobe200Item[]) {
    // The archived view reads with rchive_status, so the mocked Service has to
    // answer that read with the Storage Box contents.
    wardrobeItems = items;
    renderPage({ seed: items });
    fireEvent.click(screen.getByRole('tab', { name: 'Storage Box' }));
    await waitFor(() => expect(wardrobeRequests().some((request) => request.params?.archive_status === 'archived')).toBe(true));
    // The archived read has to land before a card exists.
    await screen.findByRole('button', { name: 'Delete Coat permanently' });
  }

  it('offers Archive on an active card and no permanent Delete', () => {
    renderPage({ seed: [wardrobeItem()] });

    expect(screen.getByRole('button', { name: 'Archive Coat' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete Coat/ })).toBeNull();
  });

  it('reads the Storage Box with archive_status=archived', async () => {
    await openStorageBox([archivedItem()]);

    const request = wardrobeRequests().find((entry) => entry.params?.archive_status === 'archived');
    expect(request).toBeDefined();
    expect(screen.getByRole('button', { name: 'Restore Coat' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Coat permanently' })).toBeInTheDocument();
  });

  it('lists every dependent outfit and its record count before confirming', async () => {
    dependentOutfits = {
      total: 2,
      outfits: [
        { id: 'outfit-1', name: 'Weekend', generationCount: 3, hasActiveGeneration: false },
        { id: 'outfit-2', name: 'Office', generationCount: 0, hasActiveGeneration: false },
      ],
    };
    await openStorageBox([archivedItem()]);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Coat permanently' }));

    const panel = await screen.findByRole('dialog', { name: 'Delete this item permanently?' });
    await waitFor(() => expect(within(panel).getAllByTestId('dependent-outfit')).toHaveLength(2));
    expect(panel).toHaveTextContent('Weekend');
    expect(panel).toHaveTextContent('3 try-ons');
    expect(panel).toHaveTextContent('also deletes 2 outfits');
    expect(panel).toHaveTextContent('stay in your history');
    const confirm = within(panel).getByRole('button', { name: 'Delete permanently' });
    expect(confirm).toBeEnabled();
    expect(deleteRequests()).toEqual([]);
  });

  it('keeps confirmation disabled while any dependent outfit has a running try-on', async () => {
    dependentOutfits = {
      total: 1,
      outfits: [{ id: 'outfit-1', name: 'Weekend', generationCount: 1, hasActiveGeneration: true }],
    };
    await openStorageBox([archivedItem()]);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Coat permanently' }));

    const panel = await screen.findByRole('dialog', { name: 'Delete this item permanently?' });
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Delete permanently' })).toBeDisabled());
    expect(within(panel).getByTestId('running-try-on-notice')).toHaveTextContent('Weekend');
    expect(within(panel).queryByRole('button', { name: /anyway/i })).toBeNull();
  });

  it('keeps confirmation disabled and offers a retry when the preview fails', async () => {
    dependentOutfitsFails = true;
    await openStorageBox([archivedItem()]);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Coat permanently' }));

    const panel = await screen.findByRole('dialog', { name: 'Delete this item permanently?' });
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Delete permanently' })).toBeDisabled());
    expect(within(panel).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('sends nothing when the confirmation is declined', async () => {
    dependentOutfits = { total: 1, outfits: [{ id: 'outfit-1', name: 'Weekend', generationCount: 0, hasActiveGeneration: false }] };
    await openStorageBox([archivedItem()]);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Coat permanently' }));
    const panel = await screen.findByRole('dialog', { name: 'Delete this item permanently?' });
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Delete permanently' })).toBeEnabled());
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));

    expect(deleteRequests()).toEqual([]);
  });

  it('issues exactly one DELETE and removes the card when confirmed', async () => {
    dependentOutfits = { total: 1, outfits: [{ id: 'outfit-1', name: 'Weekend', generationCount: 2, hasActiveGeneration: false }] };
    await openStorageBox([archivedItem()]);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Coat permanently' }));
    const panel = await screen.findByRole('dialog', { name: 'Delete this item permanently?' });
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Delete permanently' })).toBeEnabled());
    fireEvent.click(within(panel).getByRole('button', { name: 'Delete permanently' }));

    await waitFor(() => expect(deleteRequests()).toHaveLength(1));
    expect(deleteRequests()[0].url).toBe('/wardrobe/items/item-1');
  });

  it('states the already-gone outcome for a 404 without treating it as a failure', async () => {
    dependentOutfits = { total: 0, outfits: [] };
    deleteHandler = () => Promise.reject({ response: { status: 404 } });
    await openStorageBox([archivedItem()]);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Coat permanently' }));
    const panel = await screen.findByRole('dialog', { name: 'Delete this item permanently?' });
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Delete permanently' })).toBeEnabled());
    fireEvent.click(within(panel).getByRole('button', { name: 'Delete permanently' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('no longer in your wardrobe'));
  });

  it('explains the Storage Box gate when the Service answers ITEM_NOT_ARCHIVED', async () => {
    dependentOutfits = { total: 0, outfits: [] };
    deleteHandler = () => Promise.reject({
      response: {
        status: 409,
        data: { error: 'ITEM_NOT_ARCHIVED', message: 'not archived', details: { itemId: 'item-1' } },
      },
    });
    await openStorageBox([archivedItem()]);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Coat permanently' }));
    const panel = await screen.findByRole('dialog', { name: 'Delete this item permanently?' });
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Delete permanently' })).toBeEnabled());
    fireEvent.click(within(panel).getByRole('button', { name: 'Delete permanently' }));

    await waitFor(() => expect(within(panel).getByRole('alert')).toHaveTextContent('Storage Box'));
  });

  it('names the running try-on when the Service answers GENERATION_IN_PROGRESS', async () => {
    dependentOutfits = { total: 0, outfits: [] };
    deleteHandler = () => Promise.reject({
      response: {
        status: 409,
        data: {
          error: 'GENERATION_IN_PROGRESS',
          message: 'still running',
          details: {
            generation_id: 'gen-1',
            status: 'Pending',
            blocking: [{ outfitId: 'outfit-1', outfitName: 'Weekend', generationId: 'gen-1', status: 'Pending' }],
          },
        },
      },
    });
    await openStorageBox([archivedItem()]);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Coat permanently' }));
    const panel = await screen.findByRole('dialog', { name: 'Delete this item permanently?' });
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Delete permanently' })).toBeEnabled());
    fireEvent.click(within(panel).getByRole('button', { name: 'Delete permanently' }));

    await waitFor(() => expect(within(panel).getByRole('alert')).toHaveTextContent('"Weekend"'));
  });

  it('closes with a cleanup notice when the Service answers the gallery 502', async () => {
    dependentOutfits = { total: 0, outfits: [] };
    deleteHandler = () => Promise.reject({
      response: {
        status: 502,
        data: {
          error: 'OBJECT_DELETION_INCOMPLETE',
          message: 'rows deleted, object retained',
          details: { manifest_id: 'm-1', manifest_ids: ['m-1'], retained_object_keys: ['wearable-items/user-1/coat.jpg'] },
        },
      },
    });
    await openStorageBox([archivedItem()]);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Coat permanently' }));
    const panel = await screen.findByRole('dialog', { name: 'Delete this item permanently?' });
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Delete permanently' })).toBeEnabled());
    fireEvent.click(within(panel).getByRole('button', { name: 'Delete permanently' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('cleaned up in the background'));
  });

  it('archives from the active view with one request and no confirmation', async () => {
    renderPage({ seed: [wardrobeItem()] });

    fireEvent.click(screen.getByRole('button', { name: 'Archive Coat' }));

    await waitFor(() => expect(customInstanceMock.mock.calls.some(([config]) =>
      (config as Record<string, any>).method === 'POST'
      && String((config as Record<string, any>).url).endsWith('/archive'))).toBe(true));
    expect(deleteRequests()).toEqual([]);
  });

  it('restores from the Storage Box with one request', async () => {
    await openStorageBox([archivedItem()]);

    fireEvent.click(screen.getByRole('button', { name: 'Restore Coat' }));

    await waitFor(() => expect(customInstanceMock.mock.calls.some(([config]) =>
      (config as Record<string, any>).method === 'POST'
      && String((config as Record<string, any>).url).endsWith('/restore'))).toBe(true));
  });
});describe('WardrobePage outcomes of the item details dialog', () => {
  const S5 = 'This item is no longer in your wardrobe, so it was removed from this list.';

  beforeEach(() => {
    wardrobeItems = [wardrobeItem()];
  });

  it('states a started re-tag in the page notice, which outlives the dialog that asked', async () => {
    renderPage({ seed: [wardrobeItem()] });

    const props = openItemDetailsDialog();
    act(() => props.onRetagStarted?.());

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Re-tagging started. Check back shortly.');
    // The page re-reads the list so the card picks up the item's new status.
    await waitFor(() => expect(wardrobeRequests()).toHaveLength(1));
  });

  it('removes the card and states S5 for a delete whose row was already gone', async () => {
    wardrobeItems = [];
    renderPage({ seed: [wardrobeItem()] });

    const props = openItemDetailsDialog();
    act(() => props.onDeleted?.('already-gone'));

    expect(screen.queryByRole('button', { name: 'Delete Coat' })).toBeNull();
    expect(wardrobeCache()).toEqual([]);
    expect(screen.getByRole('status')).toHaveTextContent(S5);
    expect(screen.getByRole('status')).not.toHaveTextContent('outfit');
  });

  it('removes the card with no notice and moves focus to the grid region for a successful delete', async () => {
    wardrobeItems = [];
    renderPage({ seed: [wardrobeItem()] });

    const props = openItemDetailsDialog();
    act(() => props.onDeleted?.('deleted'));

    expect(screen.queryByRole('button', { name: 'Delete Coat' })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole('region', { name: 'Wardrobe items' }),
    ));
  });
});
