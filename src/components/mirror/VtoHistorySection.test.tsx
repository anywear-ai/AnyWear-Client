// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../hooks/useVtoHistory', () => ({ default: vi.fn() }));

vi.mock('../CachedImage', () => ({
  default: ({ src, alt, className }: { src: string; alt: string; className?: string }) => (
    <img src={src} alt={alt} className={className} />
  ),
}));

import VtoHistorySection from './VtoHistorySection';
import useVtoHistory from '../../hooks/useVtoHistory';
import type { GetVtoGenerations200GenerationsItem } from '../../api/model/getVtoGenerations200GenerationsItem';
import type { PostVtoGenerationsBody } from '../../api/model/postVtoGenerationsBody';

const setFilters = vi.fn();
const goToPage = vi.fn();
const rateGeneration = vi.fn();
const deleteGeneration = vi.fn();

let rows: GetVtoGenerations200GenerationsItem[] = [];

function item(id: string): GetVtoGenerations200GenerationsItem['items'][number] {
  return { id, name: null, category: 'top', images: [] };
}

function generation(
  overrides: Partial<GetVtoGenerations200GenerationsItem> = {},
): GetVtoGenerations200GenerationsItem {
  return {
    id: 'gen-1',
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    status: 'Failed',
    imageId: 'image-1',
    url: 'https://images.example.com/result.jpg',
    rating: null,
    promptUsed: null,
    advancedSettings: null,
    items: [item('item-1')],
    ...overrides,
  };
}

function mockHistory(overrides: Partial<ReturnType<typeof useVtoHistory>> = {}) {
  vi.mocked(useVtoHistory).mockReturnValue({
    generations: rows,
    total: 12,
    page: 1,
    nextPage: null,
    goToPage,
    isLoading: false,
    filters: { limit: 12 },
    setFilters,
    rateGeneration,
    deleteGeneration,
    ratingFailures: {},
    ratingEchoResetTokens: {},
    ...overrides,
  });
}

interface SectionPropsOverrides {
  onReuseOutfit?: (ids: string[]) => void;
  onRetryGeneration?: (body: PostVtoGenerationsBody) => Promise<void>;
  basePhotoId?: string | null;
  credits?: number;
  isGenerating?: boolean;
}

function renderSection(overrides: SectionPropsOverrides = {}) {
  const props = {
    onReuseOutfit: vi.fn(),
    onRetryGeneration: vi.fn().mockResolvedValue(undefined),
    basePhotoId: 'photo-1',
    credits: 5,
    isGenerating: false,
    ...overrides,
  };
  const rendered = render(<VtoHistorySection {...props} />);
  return { ...rendered, props };
}

function retryBody(call: unknown): PostVtoGenerationsBody {
  return (call as [PostVtoGenerationsBody])[0];
}

describe('VtoHistorySection action reveal', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    rows = [generation()];
    mockHistory();
  });

  afterEach(() => {
    cleanup();
  });

  it('reveals the overlay on pointer hover or focus within the overlay, never on card-scoped focus', () => {
    renderSection();
    const overlay = screen.getByTestId('vto-history-actions');

    // jsdom does not resolve Tailwind, so the token contract is the assertion.
    expect(overlay.className).toContain('group-hover:opacity-100');
    expect(overlay.className).toContain('focus-within:opacity-100');
    expect(overlay.className).toContain('focus-within:transition-none');
    expect(overlay.className).toContain('opacity-0');
    expect(overlay.className).not.toContain('group-focus-within');

    // The overlay's box is the media wrapper, and the card root keeps `group`
    // for the pointer path only.
    const media = overlay.parentElement;
    expect(media).toHaveAttribute('data-testid', 'vto-history-media');
    expect(media?.className).toContain('relative');
    expect(media?.className).toContain('aspect-[3/4]');
    expect(media?.className).toContain('overflow-hidden');
    const card = overlay.closest('.group');
    expect(card?.className).toContain('group');
    expect(card?.className).not.toContain('group-focus-within');
  });

  it('keeps the rating control and the failure sentence outside the media wrapper', () => {
    rows = [generation({ id: 'gen-1', status: 'Complete' })];
    mockHistory({
      ratingFailures: { 'gen-1': "Couldn't save your rating. Choose a star to try again." },
    });
    renderSection();

    const overlay = screen.getByTestId('vto-history-actions');
    const media = screen.getByTestId('vto-history-media');
    const radiogroup = screen.getByRole('radiogroup', { name: 'Rate this result' });
    const alert = screen.getByRole('alert');
    const card = overlay.closest('.group');

    expect(overlay.parentElement).toBe(media);
    expect(overlay.contains(radiogroup)).toBe(false);
    expect(media.contains(radiogroup)).toBe(false);
    expect(media.querySelector('[role="radiogroup"]')).toBeNull();
    expect(media.contains(alert)).toBe(false);
    expect(media.querySelector('[role="alert"]')).toBeNull();
    // The card holds both, so the containment is parentage, not absence.
    expect(card).not.toBeNull();
    expect(card?.contains(overlay)).toBe(true);
    expect(card?.contains(radiogroup)).toBe(true);
    expect(card?.contains(alert)).toBe(true);
  });

  it('keeps the five reveal tokens and adds no pointer-events or z-index token', () => {
    renderSection();
    const overlay = screen.getByTestId('vto-history-actions');

    expect(overlay.className).toContain('absolute inset-0');
    expect(overlay.className).toContain('opacity-0');
    expect(overlay.className).toContain('group-hover:opacity-100');
    expect(overlay.className).toContain('focus-within:opacity-100');
    expect(overlay.className).toContain('focus-within:transition-none');
    expect(overlay.className).not.toContain('group-focus-within');
    expect(overlay.className).not.toContain('pointer-events');
    expect(overlay.className).not.toContain('z-');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const confirmation = screen.getByTestId('vto-history-actions');
    expect(confirmation.className).toContain('opacity-100');
    expect(confirmation.className).not.toContain('opacity-0');
    expect(confirmation.className).not.toContain('pointer-events');
    expect(confirmation.className).not.toContain('z-');
  });

  it('renders a rated card as read-only text with no pressable star', () => {
    rows = [generation({ id: 'gen-1', status: 'Complete', rating: 4 })];
    mockHistory();
    renderSection();

    expect(screen.getByText('Your rating: 4/5')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getByTestId('vto-history-media').querySelector('[role="radio"]')).toBeNull();
  });

  it('keeps the actions in the tab order and the accessibility tree while hidden', () => {
    renderSection();

    for (const name of ['View Full', 'Reuse Outfit', 'Retry', 'Delete']) {
      const control = screen.getByRole('button', { name });
      expect(control).not.toHaveAttribute('aria-hidden');
      expect(control).not.toHaveAttribute('hidden');
      expect(control).not.toHaveAttribute('disabled');
      expect(control.className).not.toContain('invisible');
      expect(control.className).not.toContain('hidden');
    }
  });

  it('gives the non-destructive actions an indigo focus ring and the destructive ones a white ring', () => {
    renderSection();

    for (const name of ['View Full', 'Reuse Outfit', 'Retry']) {
      const control = screen.getByRole('button', { name });
      expect(control.className).toContain('focus-visible:ring-2');
      expect(control.className).toContain('focus-visible:ring-indigo-600');
    }
    const deleteControl = screen.getByRole('button', { name: 'Delete' });
    expect(deleteControl.className).toContain('focus-visible:ring-2');
    expect(deleteControl.className).toContain('focus-visible:ring-white');
  });

  it('keeps the overlay visible while the delete confirmation is open', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const overlay = screen.getByTestId('vto-history-actions');
    expect(overlay.className).toContain('opacity-100');
    expect(overlay.className).not.toContain('opacity-0');
    expect(screen.getByText('Delete this try-on?')).toBeInTheDocument();
  });
});

describe('VtoHistorySection Retry gate', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    rows = [];
    mockHistory();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders Retry only on the Failed row that has recorded items', () => {
    rows = [
      generation({ id: 'failed' }),
      generation({ id: 'zero-items', items: [] }),
      generation({ id: 'pending', status: 'Pending' }),
      generation({ id: 'processing', status: 'Processing' }),
      generation({ id: 'complete', status: 'Complete' }),
    ];
    mockHistory();
    renderSection();

    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
  });

  it('renders no Retry on a Failed row with zero recorded items', () => {
    rows = [generation({ items: [] })];
    mockHistory();
    renderSection();

    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('renders Retry on a Failed row with more than five recorded items', () => {
    rows = [generation({ items: ['a', 'b', 'c', 'd', 'e', 'f'].map(item) })];
    mockHistory();
    renderSection();

    expect(screen.getByText('6 wearable items')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('VtoHistorySection retry request', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    rows = [];
    mockHistory();
  });

  afterEach(() => {
    cleanup();
  });

  it('builds the exact field-level body from the row and the page base photo', async () => {
    rows = [generation({
      items: [item('item-b'), item('item-a')],
      promptUsed: 'a tailored prompt',
      advancedSettings: { size: '1024x1024', seed: 42, style: 'noir' },
    })];
    mockHistory();
    const onRetryGeneration = vi.fn().mockResolvedValue(undefined);
    renderSection({ onRetryGeneration, basePhotoId: 'photo-7' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(onRetryGeneration).toHaveBeenCalledTimes(1);
    const body = retryBody(onRetryGeneration.mock.calls[0]);
    expect(body).toEqual({
      base_photo_id: 'photo-7',
      wearable_item_ids: ['item-b', 'item-a'],
      prompt: 'a tailored prompt',
      advanced_settings: { size: '1024x1024', seed: 42 },
    });
    expect(body).not.toHaveProperty('outfit_id');
    expect(body).not.toHaveProperty('outfit_name');
  });

  it.each<[string, Partial<GetVtoGenerations200GenerationsItem>]>([
    ['a null prompt', { promptUsed: null }],
    ['an empty prompt', { promptUsed: '' }],
    ['settings that are not an object', { advancedSettings: 7 }],
    ['array settings', { advancedSettings: ['size'] }],
    ['settings with neither supported key', { advancedSettings: { style: 'noir' } }],
  ])('omits %s from the body', async (_label, overrides) => {
    rows = [generation(overrides)];
    mockHistory();
    const onRetryGeneration = vi.fn().mockResolvedValue(undefined);
    renderSection({ onRetryGeneration, basePhotoId: 'photo-1' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(retryBody(onRetryGeneration.mock.calls[0])).toEqual({
      base_photo_id: 'photo-1',
      wearable_item_ids: ['item-1'],
    });
  });
});

describe('VtoHistorySection blocked Retry', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    rows = [generation({ id: 'gen-a' }), generation({ id: 'gen-b' })];
    mockHistory();
  });

  afterEach(() => {
    cleanup();
  });

  it.each<[string, SectionPropsOverrides, string]>([
    [
      'a generation is starting or polling',
      { isGenerating: true },
      'A generation is already running — wait for it to finish.',
    ],
    [
      'no base photo is selected',
      { basePhotoId: null },
      'Select a base photo in Step 1 to retry.',
    ],
    [
      'the daily credits are spent',
      { credits: 0 },
      'Out of daily credits. Credits reset at midnight.',
    ],
  ])('marks every Retry aria-disabled with the reason while %s', async (_label, blocked, reason) => {
    const onRetryGeneration = vi.fn().mockResolvedValue(undefined);
    renderSection({ onRetryGeneration, ...blocked });

    const reasonLine = screen.getByRole('status');
    expect(reasonLine).toHaveTextContent(reason);

    const retries = screen.getAllByRole('button', { name: 'Retry' });
    expect(retries).toHaveLength(2);
    for (const retry of retries) {
      expect(retry).toHaveAttribute('aria-disabled', 'true');
      expect(retry).toHaveAttribute('aria-describedby', reasonLine.id);
      expect(retry.className).toContain('opacity-50');
      expect(retry.className).toContain('cursor-not-allowed');
      // Focusable, so a keyboard user reaches the reason.
      retry.focus();
      expect(document.activeElement).toBe(retry);
      fireEvent.click(retry);
    }
    await act(async () => {});

    expect(document.getElementById(reasonLine.id)).toBe(reasonLine);
    expect(onRetryGeneration).not.toHaveBeenCalled();
  });

  it('reports the first blocker in precedence order', () => {
    renderSection({ isGenerating: true, basePhotoId: null, credits: 0 });
    expect(screen.getByRole('status')).toHaveTextContent(
      'A generation is already running — wait for it to finish.',
    );
  });
});

describe('VtoHistorySection retry outcomes', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    rows = [generation()];
    mockHistory();
  });

  afterEach(() => {
    cleanup();
  });

  it('clears the status filter and returns to page 1 on success, without a success live region', async () => {
    // A real, non-empty status filter: an implementation that kept it would
    // call setFilters with `status: 'Failed'` here, which this assertion sees.
    mockHistory({ filters: { limit: 12, status: 'Failed' } });
    const onRetryGeneration = vi.fn().mockResolvedValue(undefined);
    renderSection({ onRetryGeneration });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(setFilters).toHaveBeenCalledTimes(1);
    expect(setFilters).toHaveBeenCalledWith({ limit: 12, status: undefined });
    expect(setFilters.mock.calls[0][0].status).toBeUndefined();
    expect(goToPage).toHaveBeenCalledWith(1);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each<[string, unknown, string]>([
    [
      'the Service message',
      { response: { status: 400, data: { message: 'No valid wearable items found' } } },
      'No valid wearable items found',
    ],
    ['the fallback', {}, 'Failed to retry this generation'],
  ])('shows %s in an alert and leaves the view alone when the retry is rejected', async (_label, rejection, message) => {
    const onRetryGeneration = vi.fn().mockRejectedValue(rejection);
    renderSection({ onRetryGeneration });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(setFilters).not.toHaveBeenCalled();
    expect(goToPage).not.toHaveBeenCalled();
    // The Failed row stays and Retry becomes available again.
    expect(screen.getByRole('button', { name: 'Retry' })).not.toHaveAttribute('aria-disabled');
  });

  it('shows Retrying… and sends nothing more while the request is pending', async () => {
    let resolveRetry!: () => void;
    const onRetryGeneration = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => { resolveRetry = resolve; }),
    );
    renderSection({ onRetryGeneration });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    const pending = screen.getByRole('button', { name: 'Retrying…' });
    expect(pending).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(pending);
    expect(onRetryGeneration).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRetry();
    });
    expect(screen.getByRole('button', { name: 'Retry' })).not.toHaveAttribute('aria-disabled');
  });
});

describe('VtoHistorySection full-image viewer', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    rows = [generation()];
    mockHistory();
  });

  afterEach(() => {
    cleanup();
  });

  function openViewer() {
    const viewFull = screen.getByRole('button', { name: 'View Full' });
    // Move focus first: the hook captures the opener at mount and restores it.
    viewFull.focus();
    fireEvent.click(viewFull);
    return viewFull;
  }

  it('opens a labelled modal dialog with focus on the close control', () => {
    renderSection();
    openViewer();

    const dialog = screen.getByRole('dialog', { name: 'Try-on full view' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByAltText('Full view')).toBeInTheDocument();
    const close = screen.getByRole('button', { name: 'Close full view' });
    expect(document.activeElement).toBe(close);
  });

  it('traps Tab inside the dialog by cancelling the boundary move', () => {
    renderSection();
    openViewer();
    const close = screen.getByRole('button', { name: 'Close full view' });
    expect(document.activeElement).toBe(close);

    // jsdom performs no Tab navigation, so the trap is proven by the cancelled
    // default: an unimpeded Tab would leave the dialog.
    const forward = createEvent.keyDown(document, { key: 'Tab' });
    fireEvent(document, forward);
    expect(forward.defaultPrevented).toBe(true);

    const backward = createEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    fireEvent(document, backward);
    expect(backward.defaultPrevented).toBe(true);

    expect(document.activeElement).toBe(close);
  });

  it('does not close when the image is clicked', () => {
    renderSection();
    openViewer();

    fireEvent.click(screen.getByAltText('Full view'));
    expect(screen.getByRole('dialog', { name: 'Try-on full view' })).toBeInTheDocument();
  });

  it('closes on the backdrop and restores focus to View Full', () => {
    renderSection();
    const viewFull = openViewer();

    fireEvent.click(screen.getByTestId('vto-viewer-backdrop'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(viewFull);
  });

  it('closes on the close control and restores focus to View Full', () => {
    renderSection();
    const viewFull = openViewer();

    fireEvent.click(screen.getByRole('button', { name: 'Close full view' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(viewFull);
  });

  it('closes on Escape and restores focus to View Full', () => {
    renderSection();
    const viewFull = openViewer();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(viewFull);
  });
});

describe('VtoHistorySection delete confirmation focus', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    rows = [generation()];
    mockHistory();
  });

  afterEach(() => {
    cleanup();
  });

  it('moves focus to Cancel when the confirmation opens and back to Delete when it closes', () => {
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);

    fireEvent.click(cancel);
    expect(screen.queryByText('Delete this try-on?')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete' }));
  });

  it('does not restore focus to the removed control after a confirmed delete', () => {
    const { props, rerender } = renderSection();
    // The delete mutation refetches and the row leaves the grid, as it does in
    // the page after `deleteGeneration` succeeds.
    deleteGeneration.mockImplementationOnce((id: string) => {
      rows = rows.filter((row) => row.id !== id);
      mockHistory();
      rerender(<VtoHistorySection {...props} />);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, Delete' }));

    expect(deleteGeneration).toHaveBeenCalledWith('gen-1');
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});

describe('VtoHistorySection rating save', () => {
  const SAVE_FAILURE = "Couldn't save your rating. Choose a star to try again.";

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    rows = [
      generation({ id: 'gen-1', status: 'Complete' }),
      generation({ id: 'gen-2', status: 'Complete' }),
    ];
    mockHistory();
  });

  afterEach(() => {
    cleanup();
  });

  it('sends the chosen star for the card whose star was clicked', () => {
    renderSection();

    const fourStars = screen.getAllByRole('radio', { name: '4 stars' });
    expect(fourStars).toHaveLength(2);
    fireEvent.click(fourStars[0]);

    expect(rateGeneration).toHaveBeenCalledTimes(1);
    expect(rateGeneration).toHaveBeenCalledWith('gen-1', 4);
  });

  it('states a failed save on the card that sent it, clears that echo, and leaves the other card alone', () => {
    const { props, rerender } = renderSection();
    const fourStars = screen.getAllByRole('radio', { name: '4 stars' });
    const sendingCard = fourStars[0].closest('.group');
    const otherCard = fourStars[1].closest('.group');
    expect(sendingCard).not.toBeNull();
    expect(otherCard).not.toBeNull();

    fourStars[0].focus();
    fireEvent.click(fourStars[0]);
    expect(screen.getByText('4 of 5 selected')).toBeInTheDocument();

    mockHistory({
      ratingFailures: { 'gen-1': SAVE_FAILURE },
      ratingEchoResetTokens: { 'gen-1': 1 },
    });
    rerender(<VtoHistorySection {...props} />);

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(SAVE_FAILURE);
    expect(alerts[0].closest('.group')).toBe(sendingCard);
    expect(screen.queryByText('4 of 5 selected')).toBeNull();
    expect(screen.getAllByRole('radio', { name: '4 stars' })[0]).toHaveAttribute('aria-checked', 'false');
    // The other card and the section-level surface show nothing.
    expect(otherCard?.querySelector('[role="alert"]')).toBeNull();
    expect(screen.getAllByRole('radio', { name: '4 stars' })[1]).toHaveAttribute('aria-checked', 'false');
  });
});
