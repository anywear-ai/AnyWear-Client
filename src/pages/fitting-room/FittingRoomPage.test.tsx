// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../api/endpoints/fitting-rooms/fitting-rooms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/endpoints/fitting-rooms/fitting-rooms')>();
  return {
    ...actual,
    useGetFittingRooms: vi.fn(),
    useGetFittingRoomsFittingRoomId: vi.fn(),
    usePostFittingRooms: vi.fn(),
    usePatchFittingRoomsFittingRoomId: vi.fn(),
    useDeleteFittingRoomsFittingRoomId: vi.fn(),
    usePostFittingRoomsFittingRoomIdItems: vi.fn(),
    useDeleteFittingRoomsFittingRoomIdItemsWearableItemId: vi.fn(),
  };
});

vi.mock('../../api/endpoints/outfits/outfits', () => ({
  useGetOutfitsLookup: vi.fn(),
  usePostOutfits: vi.fn(),
}));

vi.mock('../../api/endpoints/wardrobe/wardrobe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/endpoints/wardrobe/wardrobe')>();
  return {
    ...actual,
    useGetWardrobe: vi.fn(),
    useGetWardrobeCategories: vi.fn(),
  };
});

vi.mock('../../api/endpoints/users/users', () => ({
  useGetUsersMe: vi.fn(),
}));

vi.mock('../../api/endpoints/vto/vto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/endpoints/vto/vto')>();
  return {
    ...actual,
    useGetVtoBasePhotos: vi.fn(),
    usePostVtoBasePhotosUploadUrl: vi.fn(),
    usePostVtoBasePhotosUpload: vi.fn(),
    usePatchVtoBasePhotosId: vi.fn(),
    useDeleteVtoBasePhotosId: vi.fn(),
    usePatchVtoGenerationsGenerationIdRating: vi.fn(),
  };
});

vi.mock('../../hooks/useVtoGeneration', () => ({ default: vi.fn() }));

// Captures the props the page gives the history section, so the Reuse Outfit
// wiring can be driven without rendering the whole history grid.
const sectionProps = vi.hoisted(() => ({ latest: null as Record<string, any> | null }));

vi.mock('../../components/mirror/VtoHistorySection', () => ({
  default: (props: Record<string, any>) => {
    sectionProps.latest = props;
    return null;
  },
}));
vi.mock('../../components/mirror/CreditDisplay', () => ({ default: () => <span>5/10 today</span> }));

vi.mock('../../lib/imageUpload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/imageUpload')>();
  return { ...actual, uploadImageWithSignedPost: vi.fn() };
});
vi.mock('../../lib/imagePreparation', () => ({ prepareImageForUpload: vi.fn() }));

vi.mock('../../components/CachedImage', () => ({
  default: ({ src, cacheKey, alt, className, ...rest }: any) => (
    <img src={src} alt={alt} className={className} data-cache-key={cacheKey} {...rest} />
  ),
}));

import FittingRoomPage from './FittingRoomPage';
import {
  useDeleteFittingRoomsFittingRoomId,
  useDeleteFittingRoomsFittingRoomIdItemsWearableItemId,
  useGetFittingRooms,
  useGetFittingRoomsFittingRoomId,
  usePatchFittingRoomsFittingRoomId,
  usePostFittingRooms,
  usePostFittingRoomsFittingRoomIdItems,
} from '../../api/endpoints/fitting-rooms/fitting-rooms';
import { useGetOutfitsLookup, usePostOutfits } from '../../api/endpoints/outfits/outfits';
import { useGetWardrobe, useGetWardrobeCategories } from '../../api/endpoints/wardrobe/wardrobe';
import { useGetUsersMe } from '../../api/endpoints/users/users';
import {
  useDeleteVtoBasePhotosId,
  useGetVtoBasePhotos,
  usePatchVtoBasePhotosId,
  usePatchVtoGenerationsGenerationIdRating,
  usePostVtoBasePhotosUpload,
  usePostVtoBasePhotosUploadUrl,
} from '../../api/endpoints/vto/vto';
import useVtoGeneration from '../../hooks/useVtoGeneration';
import type { GetFittingRoomsFittingRoomId200 } from '../../api/model/getFittingRoomsFittingRoomId200';
import type { GetFittingRoomsFittingRoomId200ItemsItem } from '../../api/model/getFittingRoomsFittingRoomId200ItemsItem';

const generate = vi.fn();
const saveOutfit = vi.fn();
const stageItems = vi.fn();
const removeStagedItem = vi.fn();
const createRoom = vi.fn();
const renameRoom = vi.fn();
const deleteRoom = vi.fn();
const refetchRoom = vi.fn();
const rateGeneration = vi.fn();

const ROOM_ID = 'room-1';

function stagedItem(overrides: Partial<GetFittingRoomsFittingRoomId200ItemsItem> = {}): GetFittingRoomsFittingRoomId200ItemsItem {
  return {
    id: 'item-1',
    ownerId: 'user-1',
    name: 'T-Shirt',
    images: [{ imageId: 'image-1', url: 'https://example.com/tshirt.jpg', view: null, isPrimary: true }],
    category: 'Top',
    taggingStatus: 'ready',
    taggingStateVersion: 1,
    taggingErrorCode: null,
    taggingErrorMessage: null,
    isPublic: false,
    imageEmbedding: null,
    createdAt: '2026-05-05T00:00:00.000Z',
    updatedAt: '2026-05-05T00:00:00.000Z',
    archivedAt: null,
    addedAt: '2026-05-06T00:00:00.000Z',
    ...overrides,
  };
}

function roomDetail(items: GetFittingRoomsFittingRoomId200ItemsItem[], name = 'Fitting Room'): GetFittingRoomsFittingRoomId200 {
  return {
    id: ROOM_ID,
    userId: 'user-1',
    name,
    isDefault: true,
    itemCount: items.length,
    createdAt: '2026-05-01T00:00:00.000Z',
    items,
  };
}

let rooms: Array<{ id: string; userId: string; name: string; isDefault: boolean; itemCount: number; createdAt: string }>;
let currentRoom: GetFittingRoomsFittingRoomId200 | undefined;
let lookupResult: Record<string, unknown>;

function mockRoom(room: GetFittingRoomsFittingRoomId200 | undefined) {
  currentRoom = room;
  rooms = room
    ? [{ id: room.id, userId: room.userId, name: room.name, isDefault: room.isDefault, itemCount: room.itemCount, createdAt: room.createdAt }]
    : [];
}

function lookupMiss() {
  lookupResult = { data: { outfit: null }, isLoading: false, error: undefined };
  vi.mocked(useGetOutfitsLookup).mockReturnValue(lookupResult as never);
}

function lookupHit(outfit: Record<string, unknown>) {
  lookupResult = { data: { outfit }, isLoading: false, error: undefined };
  vi.mocked(useGetOutfitsLookup).mockReturnValue(lookupResult as never);
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = () => (
    <QueryClientProvider client={queryClient}>
      <FittingRoomPage />
    </QueryClientProvider>
  );
  const rendered = render(element());
  return { ...rendered, queryClient, rerenderPage: () => rendered.rerender(element()) };
}

/** Clicks a staged row's Select control, which is the only way to tick a piece. */
function tick(name: string) {
  fireEvent.click(screen.getByRole('button', { name: `Select ${name}` }));
}

function untick(name: string) {
  fireEvent.click(screen.getByRole('button', { name: `Deselect ${name}` }));
}

describe('a seventh tick is refused', () => {
  it('keeps the counter at five after a refused tick is followed by an untick', () => {
    mockRoom(roomDetail([
      stagedItem({ id: 'item-1', name: 'One' }),
      stagedItem({ id: 'item-2', name: 'Two' }),
      stagedItem({ id: 'item-3', name: 'Three' }),
      stagedItem({ id: 'item-4', name: 'Four' }),
      stagedItem({ id: 'item-5', name: 'Five' }),
      stagedItem({ id: 'item-6', name: 'Six' }),
    ]));
    renderPage();

    for (const name of ['One', 'Two', 'Three', 'Four', 'Five']) tick(name);
    untick('Two');

    // The refused row never moved the counter, so an untick reopens exactly one slot.
    expect(screen.getByTestId('to-try-on-counter')).toHaveTextContent('4 / 5');
    tick('Six');
    expect(screen.getByTestId('to-try-on-counter')).toHaveTextContent('5 / 5');
    expect(screen.getByRole('button', { name: 'Deselect Six' })).toBeInTheDocument();
  });
});

/**
 * One setup for every block: the page reads the room list, the room detail, the
 * photo list and the profile at mount, so a test that only changes one of them
 * must still have the others answer.
 */
beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  sectionProps.latest = null;
  vi.mocked(useGetUsersMe).mockReturnValue({ data: { dailyCredits: 5 } } as never);
  vi.mocked(useGetVtoBasePhotos).mockReturnValue({
    data: [{ id: 'photo-own', userId: 'user-1', imageId: 'image-own', url: 'https://example.com/base.jpg', isDefault: true, source: 'user', createdAt: '2026-06-01T00:00:00.000Z' }],
    isLoading: false,
  } as never);
  vi.mocked(useVtoGeneration).mockReturnValue({
    generate,
    result: null,
    errorMessage: null,
    isPolling: false,
    isStarting: false,
    isTerminal: false,
    vtoId: null,
  } as never);
  vi.mocked(usePostVtoBasePhotosUploadUrl).mockReturnValue({ mutateAsync: vi.fn() } as never);
  vi.mocked(usePostVtoBasePhotosUpload).mockReturnValue({ mutateAsync: vi.fn() } as never);
  vi.mocked(usePatchVtoBasePhotosId).mockReturnValue({ mutate: vi.fn() } as never);
  vi.mocked(useDeleteVtoBasePhotosId).mockReturnValue({ mutate: vi.fn() } as never);
  vi.mocked(usePatchVtoGenerationsGenerationIdRating).mockReturnValue({ mutateAsync: rateGeneration } as never);
  vi.mocked(usePostFittingRoomsFittingRoomIdItems).mockReturnValue({ mutateAsync: stageItems, isPending: false } as never);
  vi.mocked(useDeleteFittingRoomsFittingRoomIdItemsWearableItemId).mockReturnValue({ mutateAsync: removeStagedItem, isPending: false } as never);
  vi.mocked(usePostFittingRooms).mockReturnValue({ mutateAsync: createRoom, isPending: false } as never);
  vi.mocked(usePatchFittingRoomsFittingRoomId).mockReturnValue({ mutateAsync: renameRoom, isPending: false } as never);
  vi.mocked(useDeleteFittingRoomsFittingRoomId).mockReturnValue({ mutateAsync: deleteRoom, isPending: false } as never);
  vi.mocked(usePostOutfits).mockReturnValue({ mutateAsync: saveOutfit } as never);
  vi.mocked(useGetWardrobe).mockReturnValue({
    data: [{
      id: 'item-1',
      ownerId: 'user-1',
      name: 'T-Shirt',
      images: [{ imageId: 'image-1', url: 'https://example.com/tshirt.jpg', view: null, isPrimary: true }],
      category: 'Top',
      taggingStatus: 'ready',
      taggingStateVersion: 1,
      taggingErrorCode: null,
      taggingErrorMessage: null,
      weatherTags: null,
      styleAttributes: { color: 'Blue', material: 'Cotton' },
      isPublic: false,
      imageEmbedding: null,
      createdAt: '2026-05-05T00:00:00.000Z',
      updatedAt: '2026-05-05T00:00:00.000Z',
      archivedAt: null,
    }],
    isLoading: false,
  } as never);
  vi.mocked(useGetWardrobeCategories).mockReturnValue({ data: { categories: ['Top'] } } as never);
  // jsdom has no scrolling implementation; the Reuse Outfit path asks for one.
  Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true, configurable: true });
  refetchRoom.mockResolvedValue({});
  stageItems.mockImplementation(async () => currentRoom);
  removeStagedItem.mockResolvedValue(undefined);
  saveOutfit.mockResolvedValue({ id: 'outfit-1', name: 'T-Shirt' });
  createRoom.mockResolvedValue({ id: 'room-2', name: 'Dressing', isDefault: false, itemCount: 0 });
  renameRoom.mockResolvedValue({});
  deleteRoom.mockResolvedValue(undefined);
  generate.mockResolvedValue({ generation_id: 'generation-1', outfit_id: 'outfit-1' });
  lookupMiss();
  mockRoom(roomDetail([stagedItem()]));
  vi.mocked(useGetFittingRooms).mockImplementation(() => ({ data: { fittingRooms: rooms }, isError: false } as never));
  vi.mocked(useGetFittingRoomsFittingRoomId).mockImplementation(() => ({ data: currentRoom, isLoading: false, refetch: refetchRoom } as never));
});

afterEach(() => {
  cleanup();
});

describe('FittingRoomPage hierarchy and room', () => {
  it('heads the page with Fitting Room and puts the room switcher below it', () => {
    renderPage();

    const heading = screen.getByRole('heading', { level: 1, name: 'Fitting Room' });
    expect(heading).toBeInTheDocument();
    // The switcher follows the heading in document order, not above it.
    const switcher = screen.getByRole('group', { name: 'Fitting rooms' });
    expect(heading.compareDocumentPosition(switcher) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('names the two areas exactly Wardrobe and To try on, each with one purpose sentence', () => {
    renderPage();

    const wardrobe = screen.getByRole('heading', { level: 2, name: 'Wardrobe' });
    const toTryOn = screen.getByRole('heading', { level: 2, name: 'To try on' });
    expect(wardrobe).toBeInTheDocument();
    expect(toTryOn).toBeInTheDocument();
    // The tab has the same name as one area on purpose; the level and the
    // sentence are what tell the two apart.
    expect(wardrobe.tagName).toBe('H2');
    expect(screen.getByText(/Every piece you own\./)).toBeInTheDocument();
    expect(screen.getByText(/The pieces staged in this room\./)).toBeInTheDocument();
  });

  it('opens the first room the list read returns and lists its staged members', () => {
    renderPage();

    expect(useGetFittingRoomsFittingRoomId).toHaveBeenCalledWith(ROOM_ID, expect.anything());
    expect(screen.getByTestId('to-try-on-row')).toHaveTextContent('T-Shirt');
    expect(screen.getByRole('button', { name: /Fitting Room/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('stages a piece from the Wardrobe area with Add … to try on and never ticks it', async () => {
    stageItems.mockResolvedValue(roomDetail([stagedItem(), stagedItem({ id: 'item-2', name: 'Jeans' })]));
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Add T-Shirt to try on' }));

    await waitFor(() => expect(stageItems).toHaveBeenCalledWith({
      fittingRoomId: ROOM_ID,
      data: { wearable_item_ids: ['item-1'] },
    }));
    // Adding stages: the tick belongs to the To try on area only.
    expect(screen.queryByRole('button', { name: 'Deselect T-Shirt' })).toBeNull();
  });

  it('stages six or more pieces and only bounds the ticked subset', () => {
    const six = Array.from({ length: 6 }, (_, index) => stagedItem({ id: `item-${index + 1}`, name: `Piece ${index + 1}` }));
    mockRoom(roomDetail(six));
    renderPage();

    expect(screen.getAllByTestId('to-try-on-row')).toHaveLength(6);
    expect(screen.getByTestId('to-try-on-counter')).toHaveTextContent('0 / 5');
  });
});

describe('FittingRoomPage selection bounds', () => {

  it('keeps both primary buttons disabled with zero ticks', () => {
    mockRoom(roomDetail([stagedItem()]));
    const { rerenderPage } = renderPage();

    expect(screen.getByRole('button', { name: 'Generate try-on' })).toBeDisabled();
    fireEvent.click(screen.getByRole('switch', { name: 'Try it on now (1 credit)' }));
    expect(screen.getByRole('button', { name: 'Save outfit' })).toBeDisabled();
    rerenderPage();
    expect(screen.getByRole('button', { name: 'Save outfit' })).toBeDisabled();
  });

  it('refuses a sixth tick with the up-to-5 sentence and leaves the first five ticked', () => {
    const six = Array.from({ length: 6 }, (_, index) => stagedItem({ id: `item-${index + 1}`, name: `Piece ${index + 1}` }));
    mockRoom(roomDetail(six));
    renderPage();

    for (let index = 1; index <= 5; index += 1) tick(`Piece ${index}`);
    expect(screen.getByTestId('to-try-on-counter')).toHaveTextContent('5 / 5');

    tick('Piece 6');

    expect(screen.getByRole('button', { name: 'Select Piece 6' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('up to 5 at a time');
    expect(screen.getByTestId('to-try-on-counter')).toHaveTextContent('5 / 5');
  });

  it('shows an archived staged member with its badge and no way to tick it', () => {
    mockRoom(roomDetail([
      stagedItem(),
      stagedItem({ id: 'item-2', name: 'Jeans', archivedAt: '2026-05-10T00:00:00.000Z' }),
    ]));
    renderPage();

    expect(screen.getByTestId('to-try-on-archived')).toHaveTextContent('Archived');
    expect(screen.getByRole('button', { name: 'Select Jeans' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Jeans from try on' })).toBeEnabled();
  });

  it('keeps the primary button disabled when only archived members are staged', () => {
    mockRoom(roomDetail([stagedItem({ archivedAt: '2026-05-10T00:00:00.000Z' })]));
    renderPage();

    expect(screen.getByRole('button', { name: 'Generate try-on' })).toBeDisabled();
    fireEvent.click(screen.getByRole('switch', { name: 'Try it on now (1 credit)' }));
    expect(screen.getByRole('button', { name: 'Save outfit' })).toBeDisabled();
  });
});

describe('FittingRoomPage compose paths', () => {
  beforeEach(() => {
    mockRoom(roomDetail([stagedItem(), stagedItem({ id: 'item-2', name: 'Jeans' })]));
    saveOutfit.mockResolvedValue({ id: 'outfit-1', name: 'T-Shirt, Jeans' });
  });


  it('switches only the primary button: the ticks stay ticked', () => {
    renderPage();

    tick('T-Shirt');
    expect(screen.getByRole('button', { name: 'Generate try-on' })).toBeEnabled();
    expect(screen.getByText('This uses 1 of your daily credits.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Try it on now (1 credit)' }));

    expect(screen.getByRole('switch', { name: 'Try it on now (1 credit)' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: 'Save outfit' })).toBeEnabled();
    expect(screen.getByText('No credit is charged for saving an outfit.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deselect T-Shirt' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('saves the ticked set with the member list only, and keeps To try on populated', async () => {
    vi.mocked(useGetOutfitsLookup).mockReturnValue({ data: undefined, isLoading: false, error: undefined } as never);
    renderPage();

    tick('T-Shirt');
    tick('Jeans');
    fireEvent.click(screen.getByRole('switch', { name: 'Try it on now (1 credit)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save outfit' }));

    await waitFor(() => expect(saveOutfit).toHaveBeenCalledTimes(1));
    const request = saveOutfit.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(Object.keys(request.data)).toEqual(['wearable_item_ids']);
    expect(request.data.wearable_item_ids).toEqual(['item-1', 'item-2']);
    // The save is not a generate and there is no name input on the page.
    expect(generate).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/outfit name/i)).toBeNull();
    // The staging area survives the compose attempt.
    expect(screen.getAllByTestId('to-try-on-row')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Deselect T-Shirt' })).toBeInTheDocument();
  });

  /**
   * `POST /outfits` is find-or-create: a `200` returns an outfit that already holds
   * this set, and that outfit may already have a look. The notice follows what the
   * response returned, using the same two states the Wardrobe card paints, so a
   * matched outfit with a look is never called "no look yet".
   */
  it('reports a matched outfit that already has a look, without claiming no look', async () => {
    saveOutfit.mockResolvedValue({
      id: 'outfit-1',
      name: 'Weekend Casual',
      latestGeneration: { id: 'gen-1', status: 'Complete', errorCode: null, createdAt: '2026-06-01T00:00:00.000Z' },
      look: { generationId: 'gen-1', url: 'https://example.com/look.png', createdAt: '2026-06-01T00:00:00.000Z' },
    });
    renderPage();

    tick('T-Shirt');
    fireEvent.click(screen.getByRole('switch', { name: 'Try it on now (1 credit)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save outfit' }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('Matched an existing outfit');
    expect(notice).toHaveTextContent('Weekend Casual');
    expect(notice).toHaveTextContent('already has a look for this combination');
    expect(notice).not.toHaveTextContent(/no look yet/i);
  });

  it('reports a set saved without a look, naming Generate look as the way to render it', async () => {
    saveOutfit.mockResolvedValue({
      id: 'outfit-1',
      name: 'T-Shirt, Jeans',
      latestGeneration: null,
      look: null,
    });
    renderPage();

    tick('T-Shirt');
    fireEvent.click(screen.getByRole('switch', { name: 'Try it on now (1 credit)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save outfit' }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('no look yet');
    expect(notice).toHaveTextContent('Generate look on its card');
    expect(notice).not.toHaveTextContent(/Matched an existing outfit/);
  });

  /**
   * The lookup is the step that shows a matched outfit before a credit is spent, so
   * a click during it must not send Mode B. The control is held until the lookup
   * settles; a hit then reaches the confirmation and the next click is Mode A.
   */
  it('holds the compose action during the in-flight lookup, then sends Mode A once the hit renders', async () => {
    vi.mocked(useGetOutfitsLookup).mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetching: true,
      error: undefined,
    } as never);
    const { rerenderPage } = renderPage();

    tick('T-Shirt');

    const held = screen.getByRole('button', { name: 'Generate try-on' });
    expect(held).toBeDisabled();
    fireEvent.click(held);
    expect(generate).not.toHaveBeenCalled();

    // The lookup resolves to a hit: the confirmation renders and the control opens.
    vi.mocked(useGetOutfitsLookup).mockReturnValue({
      data: { outfit: { id: 'outfit-9', name: 'Weekend Casual', generationCount: 2 } },
      isLoading: false,
      isFetching: false,
      error: undefined,
    } as never);
    rerenderPage();

    expect(screen.getByTestId('outfit-lookup-hit')).toHaveTextContent('Weekend Casual');
    const ready = screen.getByRole('button', { name: 'Generate try-on' });
    expect(ready).toBeEnabled();

    fireEvent.click(ready);

    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    const body = generate.mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({ base_photo_id: 'photo-own', outfit_id: 'outfit-9' });
    expect(body.wearable_item_ids).toBeUndefined();
  });

  it('never holds Save outfit, because the save path looks nothing up', () => {
    // A lookup would be in flight for the same ticks with the switch on; the off
    // path makes no request, so its control has nothing to wait for.
    vi.mocked(useGetOutfitsLookup).mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetching: true,
      error: undefined,
    } as never);
    renderPage();

    tick('T-Shirt');
    fireEvent.click(screen.getByRole('switch', { name: 'Try it on now (1 credit)' }));

    expect(screen.getByRole('button', { name: 'Save outfit' })).toBeEnabled();
  });

  it('saves with a drained balance because no credit is charged', () => {
    vi.mocked(useGetUsersMe).mockReturnValue({ data: { dailyCredits: 0 } } as never);
    renderPage();

    tick('T-Shirt');
    fireEvent.click(screen.getByRole('switch', { name: 'Try it on now (1 credit)' }));

    expect(screen.getByRole('button', { name: 'Save outfit' })).toBeEnabled();
  });

  it('generates against the matched outfit id and sends no outfit name', async () => {
    lookupHit({ id: 'outfit-9', name: 'Weekend Casual', generationCount: 2, wearableItems: [], latestGeneration: null, look: null });
    renderPage();

    tick('T-Shirt');
    expect(screen.getByTestId('outfit-lookup-hit')).toHaveTextContent('Weekend Casual');
    fireEvent.click(screen.getByRole('button', { name: 'Generate try-on' }));

    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    const body = generate.mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({ base_photo_id: 'photo-own', outfit_id: 'outfit-9' });
    expect(body.wearable_item_ids).toBeUndefined();
    expect(Object.keys(body)).not.toContain('outfit_name');
  });

  it('generates the item list on a lookup miss and sends no outfit name', async () => {
    renderPage();

    tick('T-Shirt');
    tick('Jeans');
    fireEvent.click(screen.getByRole('button', { name: 'Generate try-on' }));

    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    const body = generate.mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({ base_photo_id: 'photo-own', wearable_item_ids: ['item-1', 'item-2'] });
    expect(Object.keys(body)).not.toContain('outfit_name');
  });

  it('unticks the ids a 400 names, re-reads the room and asks the user to try again', async () => {
    generate.mockRejectedValueOnce({
      response: {
        status: 400,
        data: {
          code: 'VALIDATION_ERROR',
          message: 'One or more wearable items are in the Storage Box',
          details: { archivedItemIds: ['item-2'] },
        },
      },
    });
    renderPage();

    tick('T-Shirt');
    tick('Jeans');
    fireEvent.click(screen.getByRole('button', { name: 'Generate try-on' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('try again'));
    expect(screen.getByRole('status')).toHaveTextContent('in the Storage Box');
    // Exactly the named id is unticked; the other one stays selected.
    expect(screen.getByRole('button', { name: 'Select Jeans' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Deselect T-Shirt' })).toHaveAttribute('aria-pressed', 'true');
    expect(refetchRoom).toHaveBeenCalled();
    // The request was never silently shrunk and retried.
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('routes a refused lookup through the same handler', async () => {
    vi.mocked(useGetOutfitsLookup).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: {
        response: {
          status: 400,
          data: { code: 'VALIDATION_ERROR', message: 'archived', details: { archivedItemIds: ['item-2'] } },
        },
      },
    } as never);
    renderPage();

    tick('T-Shirt');
    tick('Jeans');
    fireEvent.click(screen.getByRole('button', { name: 'Generate try-on' }));

    // The lookup refused before anything was charged; the same handler unticked
    // the named id, re-read the room and asked the user to try again.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('in the Storage Box'));
    expect(screen.getByRole('button', { name: 'Select Jeans' })).toHaveAttribute('aria-pressed', 'false');
    expect(refetchRoom).toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('reuses a history record by staging its items in the current room and ticking them', async () => {
    renderPage();

    const onReuseOutfit = sectionProps.latest!.onReuseOutfit as (ids: string[]) => void;
    await act(async () => {
      onReuseOutfit(['item-1', 'item-2']);
    });

    expect(stageItems).toHaveBeenCalledWith({
      fittingRoomId: ROOM_ID,
      data: { wearable_item_ids: ['item-1', 'item-2'] },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deselect T-Shirt' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Deselect Jeans' })).toBeInTheDocument();
  });
});

describe('FittingRoomPage room actions', () => {
  beforeEach(() => {
    mockRoom(roomDetail([stagedItem()], 'Studio'));
  });


  it('creates a room with the typed name', async () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'New room' }));
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: '  Dressing  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));

    await waitFor(() => expect(createRoom).toHaveBeenCalledWith({ data: { name: 'Dressing' } }));
  });

  it('creates a room with no name at all, which the Service stores as Fitting Room', async () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'New room' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));

    await waitFor(() => expect(createRoom).toHaveBeenCalledWith({ data: {} }));
  });

  it('renames the open room and holds a blank name with the length requirement', async () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByLabelText('Room name');
    expect(input).toHaveValue('Studio');

    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('1 to 200 characters');

    fireEvent.change(input, { target: { value: 'x'.repeat(201) } });
    expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('at most 200 characters');

    fireEvent.change(input, { target: { value: 'Evening' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

    await waitFor(() => expect(renameRoom).toHaveBeenCalledWith({ fittingRoomId: ROOM_ID, data: { name: 'Evening' } }));
  });

  it('deletes a room only after the confirmation and says what the delete does', async () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Studio?' });
    expect(dialog).toHaveTextContent('The pieces stay in your wardrobe');
    expect(dialog).toHaveTextContent('your other rooms are untouched');
    expect(deleteRoom).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete room' }));
    await waitFor(() => expect(deleteRoom).toHaveBeenCalledWith({ fittingRoomId: ROOM_ID }));
  });

  it('removes a staged piece from the room and untints it', async () => {
    removeStagedItem.mockResolvedValue(undefined);
    renderPage();

    tick('T-Shirt');
    fireEvent.click(screen.getByRole('button', { name: 'Remove T-Shirt from try on' }));

    await waitFor(() => expect(removeStagedItem).toHaveBeenCalledWith({
      fittingRoomId: ROOM_ID,
      wearableItemId: 'item-1',
    }));
    expect(refetchRoom).toHaveBeenCalled();
  });
});
