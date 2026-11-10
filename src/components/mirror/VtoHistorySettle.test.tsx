// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../api/custom-instance', () => ({ customInstance: vi.fn() }));
vi.mock('aws-amplify/auth', () => ({ fetchAuthSession: vi.fn() }));

// The result area and the history grid cache their thumbnails through the same
// component; the double renders the signed URL so the assertions read it.
vi.mock('../CachedImage', () => ({
  default: ({ src, alt, className }: { src: string; alt: string; className?: string }) => (
    <img src={src} alt={alt} className={className} />
  ),
}));

import ResultArea from './ResultArea';
import VtoHistorySection from './VtoHistorySection';
import useVtoGeneration from '../../hooks/useVtoGeneration';
import { customInstance } from '../../api/custom-instance';
import { fetchAuthSession } from 'aws-amplify/auth';
import type { VtoStatusResponse } from '../../api/model/vtoStatusResponse';
import type { GetVtoGenerations200 } from '../../api/model/getVtoGenerations200';
import type { GetVtoGenerations200GenerationsItem } from '../../api/model/getVtoGenerations200GenerationsItem';
import type { GetVtoGenerations200GenerationsItemItemsItem } from '../../api/model/getVtoGenerations200GenerationsItemItemsItem';

const SETTLED_URL = 'https://images.example.com/generation-1.jpg';

const pendingStatus: VtoStatusResponse = {
  generation_id: 'generation-1',
  status: 'Processing',
  state_version: 1,
  imageId: null,
  url: null,
  created_at: '2026-11-07T00:00:00.000Z',
  rating: null,
};

const completeFrame: VtoStatusResponse = {
  ...pendingStatus,
  status: 'Complete',
  state_version: 2,
  imageId: 'image-1',
  url: SETTLED_URL,
};

const failedFrame: VtoStatusResponse = {
  ...pendingStatus,
  status: 'Failed',
  state_version: 2,
  imageId: null,
  url: null,
  error_message: 'The provider rejected the image',
};

function item(id: string): GetVtoGenerations200GenerationsItemItemsItem {
  return { id, name: null, category: 'top', images: [] };
}

function historyRow(
  overrides: Partial<GetVtoGenerations200GenerationsItem> & Pick<GetVtoGenerations200GenerationsItem, 'id'>,
): GetVtoGenerations200GenerationsItem {
  return {
    createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    status: 'Pending',
    imageId: null,
    url: null,
    rating: null,
    promptUsed: null,
    advancedSettings: null,
    items: [item('item-1')],
    ...overrides,
  };
}

/**
 * Three history rows whose second row is the generation under test.
 *
 * The second row already carries `rating: 4` while the terminal status carries
 * `rating: null`: a card that shows 4 proves the derivation took the row's own
 * rating and not the status's.
 */
function historyPage(): GetVtoGenerations200 {
  const now = Date.now();
  return {
    generations: [
      historyRow({
        id: 'generation-0',
        createdAt: new Date(now - 3_600_000).toISOString(),
        status: 'Complete',
        imageId: 'image-0',
        url: 'https://images.example.com/generation-0.jpg',
        rating: 2,
        items: [item('item-a'), item('item-b')],
      }),
      historyRow({
        id: 'generation-1',
        createdAt: new Date(now - 2 * 3_600_000).toISOString(),
        items: [item('item-c'), item('item-d'), item('item-e')],
        rating: 4,
      }),
      historyRow({
        id: 'generation-2',
        createdAt: new Date(now - 3 * 3_600_000).toISOString(),
        status: 'Failed',
        items: [],
      }),
    ],
    total: 3,
    page: 1,
    limit: 12,
    nextPage: null,
  };
}

/**
 * The two surfaces as `MirrorPage` wires them: `ResultArea` and the real
 * `VtoHistorySection` share this provider and the one `useVtoGeneration` state,
 * so `settledStatus` is the same terminal status Step 4 renders.
 */
function MirrorSurfaces() {
  const { generate, result, isTerminal, vtoId, isStarting, isPolling } = useVtoGeneration();

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void generate({ base_photo_id: 'photo-1', outfit_id: 'outfit-1' });
        }}
      >
        Generate try-on
      </button>
      <section aria-label="Step 4">
        <ResultArea
          vtoId={vtoId}
          result={result}
          onRetry={() => {}}
          onRate={() => {}}
          ratingError={null}
        />
      </section>
      <section aria-label="History">
        <VtoHistorySection
          onReuseOutfit={() => {}}
          onRetryGeneration={async () => {}}
          basePhotoId="photo-1"
          credits={5}
          isGenerating={isStarting || isPolling}
          settledStatus={isTerminal ? result : null}
        />
      </section>
    </div>
  );
}

interface ListRequest {
  resolve: (page: GetVtoGenerations200) => void;
}

function historyCards(): HTMLElement[] {
  return screen.getAllByTestId('vto-history-media').map((media) => {
    const card = media.closest('.group');
    if (!(card instanceof HTMLElement)) throw new Error('A history media wrapper has no card root');
    return card;
  });
}

describe('VtoHistorySettle', () => {
  const clients: QueryClient[] = [];
  let listRequests: ListRequest[];
  let streamControllers: ReadableStreamDefaultController<Uint8Array>[];

  beforeEach(() => {
    vi.clearAllMocks();
    listRequests = [];
    streamControllers = [];
    vi.mocked(customInstance).mockImplementation((config) => {
      if (config.method === 'POST') {
        return Promise.resolve({ generation_id: 'generation-1', outfit_id: 'outfit-1' });
      }
      if (config.method === 'GET' && config.url === '/vto/generations') {
        return new Promise<GetVtoGenerations200>((resolve) => {
          listRequests.push({ resolve });
        });
      }
      return Promise.resolve(pendingStatus);
    });
    vi.mocked(fetchAuthSession).mockResolvedValue({
      tokens: { accessToken: { toString: () => 'access-token' } },
    } as Awaited<ReturnType<typeof fetchAuthSession>>);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => (
      new Response(new ReadableStream<Uint8Array>({
        start(controller) { streamControllers.push(controller); },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    )));
  });

  afterEach(() => {
    cleanup();
    clients.splice(0).forEach((client) => client.clear());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function renderSurfaces() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    clients.push(queryClient);
    return render(
      <QueryClientProvider client={queryClient}>
        <MirrorSurfaces />
      </QueryClientProvider>,
    );
  }

  async function flush() {
    await act(async () => {});
  }

  async function sendFrame(frame: VtoStatusResponse) {
    await act(async () => {
      streamControllers[0].enqueue(new TextEncoder().encode(
        `event: status\ndata: ${JSON.stringify(frame)}\n\n`,
      ));
    });
    await flush();
  }

  /** Starts the generation and waits until its stream can deliver a frame. */
  async function startGeneration() {
    fireEvent.click(screen.getByRole('button', { name: 'Generate try-on' }));
    await waitFor(() => expect(streamControllers).toHaveLength(1));
  }

  it('case A: the card is Complete on its first appearance although the held page says Pending', async () => {
    renderSurfaces();
    await waitFor(() => expect(listRequests).toHaveLength(1));
    await startGeneration();

    // The first page read is held while the run settles, so the card does not
    // exist yet; the settle invalidation joins that read and issues no second.
    await sendFrame(completeFrame);
    expect(listRequests).toHaveLength(1);
    await waitFor(() =>
      expect(screen.getByAltText('Try-on result')).toHaveAttribute('src', SETTLED_URL));

    await act(async () => { listRequests[0].resolve(historyPage()); });

    await waitFor(() => expect(historyCards()).toHaveLength(3));
    const [firstCard, secondCard, thirdCard] = historyCards();

    // Step 4 and the card state the same thing in the render the page arrived.
    expect(screen.getByAltText('Try-on result')).toHaveAttribute('src', SETTLED_URL);
    expect(within(secondCard).getByAltText('Try-on history')).toHaveAttribute('src', SETTLED_URL);
    expect(within(secondCard).getByText('Complete')).toBeInTheDocument();
    expect(within(secondCard).queryByText('Pending')).toBeNull();
    expect(within(secondCard).queryByText('Processing')).toBeNull();

    // The second card keeps its index, timestamp, item count and stars.
    expect(within(firstCard).getByText('1h ago')).toBeInTheDocument();
    expect(within(secondCard).getByText('2h ago')).toBeInTheDocument();
    expect(within(thirdCard).getByText('3h ago')).toBeInTheDocument();
    expect(within(secondCard).getByText('3 wearable items')).toBeInTheDocument();
    expect(within(secondCard).getByText('Your rating: 4/5')).toBeInTheDocument();
  });

  it('case B: a reconciliation read that resolves Pending cannot bring the badge back', async () => {
    renderSurfaces();
    await waitFor(() => expect(listRequests).toHaveLength(1));
    await act(async () => { listRequests[0].resolve(historyPage()); });
    await waitFor(() => expect(historyCards()).toHaveLength(3));
    expect(within(historyCards()[1]).getByText('Pending')).toBeInTheDocument();

    await startGeneration();
    // The start invalidation re-reads the page while the run is in flight.
    await waitFor(() => expect(listRequests).toHaveLength(2));
    await act(async () => { listRequests[1].resolve(historyPage()); });
    await flush();

    await sendFrame(completeFrame);
    await waitFor(() =>
      expect(screen.getByAltText('Try-on result')).toHaveAttribute('src', SETTLED_URL));

    // The settle's one read is unresolved; the card does not wait for it.
    await waitFor(() => expect(listRequests).toHaveLength(3));
    const secondCard = historyCards()[1];
    expect(within(secondCard).getByAltText('Try-on history')).toHaveAttribute('src', SETTLED_URL);
    expect(within(secondCard).getByText('Complete')).toBeInTheDocument();
    expect(within(secondCard).queryByText('Pending')).toBeNull();
    expect(within(secondCard).queryByText('Processing')).toBeNull();
    expect(within(secondCard).getByText('2h ago')).toBeInTheDocument();
    expect(within(secondCard).getByText('3 wearable items')).toBeInTheDocument();
    expect(within(secondCard).getByText('Your rating: 4/5')).toBeInTheDocument();

    // That read lands late with the row still Pending; the card stays Complete.
    await act(async () => { listRequests[2].resolve(historyPage()); });
    await flush();

    const lateSecondCard = historyCards()[1];
    expect(within(lateSecondCard).getByAltText('Try-on history')).toHaveAttribute('src', SETTLED_URL);
    expect(within(lateSecondCard).getByText('Complete')).toBeInTheDocument();
    expect(within(lateSecondCard).queryByText('Pending')).toBeNull();
    expect(within(lateSecondCard).queryByText('Processing')).toBeNull();
  });

  it('Failed: the card shows the failure in the same render as Step 4', async () => {
    renderSurfaces();
    await waitFor(() => expect(listRequests).toHaveLength(1));
    await act(async () => { listRequests[0].resolve(historyPage()); });
    await waitFor(() => expect(historyCards()).toHaveLength(3));

    await startGeneration();
    await waitFor(() => expect(listRequests).toHaveLength(2));
    await act(async () => { listRequests[1].resolve(historyPage()); });
    await flush();

    await sendFrame(failedFrame);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Generation Failed' })).toBeInTheDocument());

    // One assertion block: Step 4's failure panel, and the same generation's
    // card already terminal, with the failure placeholder and the retry control.
    const secondCard = historyCards()[1];
    expect(within(secondCard).getByText('Failed')).toHaveClass('bg-red-100', 'text-red-800');
    expect(within(secondCard).getByText('Generation failed')).toBeInTheDocument();
    expect(within(secondCard).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(within(secondCard).queryByText('Pending')).toBeNull();
    expect(within(secondCard).queryByText('Processing')).toBeNull();
    expect(within(secondCard).getByText('3 wearable items')).toBeInTheDocument();
  });
});
