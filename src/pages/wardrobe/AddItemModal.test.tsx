// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, fireEvent, cleanup, waitFor, screen, within } from '@testing-library/react';

vi.mock('../../api/endpoints/wardrobe/wardrobe', () => ({
  usePostWardrobeUploadUrl: vi.fn(),
  usePostWardrobeUpload: vi.fn(),
}));

import AddItemModal from './AddItemModal';
import { CONFIRM_CHECK_WARDROBE_HINT } from '../../lib/batchUpload';
import { HEIC_UNSUPPORTED_MESSAGE } from '../../lib/imageUpload';
import { usePostWardrobeUpload, usePostWardrobeUploadUrl } from '../../api/endpoints/wardrobe/wardrobe';

const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** The tokens jsdom cannot paint: both the width and the colour must be authored. */
function expectRingTokens(element: HTMLElement, state = 'focus:') {
  const tokens = element.className.split(/\s+/);
  expect(tokens, `${element.tagName} is missing ${state}ring-2`).toContain(`${state}ring-2`);
  expect(tokens, `${element.tagName} is missing ${state}ring-indigo-500`).toContain(`${state}ring-indigo-500`);
}

/** Every focusable control in the dialog, with the file input resolved through its label. */
function expectEveryStopRings(dialog: HTMLElement) {
  const stops = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((element) => !element.classList.contains('hidden'));
  expect(stops.length).toBeGreaterThan(0);

  for (const stop of stops) {
    if (stop instanceof HTMLInputElement && stop.type === 'file') {
      const label = stop.closest('label');
      expect(label).not.toBeNull();
      expectRingTokens(label!, 'focus-within:');
      continue;
    }
    expectRingTokens(stop);
  }
}

describe('AddItemModal', () => {
  const onClose = vi.fn();
  const onSuccess = vi.fn();
  const getUploadUrl = vi.fn();
  const confirmUpload = vi.fn();

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    // `clearAllMocks` drops call history but keeps implementations, so a stub one
    // test installed would otherwise leak into the next; reset both shared fns so
    // every test declares the behaviour it depends on.
    getUploadUrl.mockReset();
    confirmUpload.mockReset();
    document.body.style.overflow = '';
    vi.mocked(usePostWardrobeUploadUrl).mockReturnValue({ mutateAsync: getUploadUrl } as any);
    vi.mocked(usePostWardrobeUpload).mockReturnValue({ mutateAsync: confirmUpload } as any);
    vi.spyOn(window, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    document.body.style.overflow = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('narrows the picker and rejects a HEIC photo before reserving an upload', async () => {
    const { container } = render(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');

    expect(input).not.toBeNull();
    expect(input).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');

    // The browser omits the MIME type, so only the filename identifies the format.
    fireEvent.change(input!, { target: { files: [new File(['x'], 'photo.heic')] } });
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith(expect.stringContaining(HEIC_UNSUPPORTED_MESSAGE));
    });
    expect(getUploadUrl).not.toHaveBeenCalled();
    expect(confirmUpload).not.toHaveBeenCalled();
  });

  it('announces both visible upload texts and names the close, submit, and cancel controls', () => {
    render(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);

    const input = screen.getByLabelText('Image Upload a file or take a photo');
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('id', 'add-item-image');

    const dialog = screen.getByRole('dialog', { name: 'Add Wardrobe Item' });
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Upload & Auto-Tag' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('paints the 2px indigo ring tokens on every focus stop through the file input label', () => {
    render(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);

    expectEveryStopRings(screen.getByRole('dialog', { name: 'Add Wardrobe Item' }));
  });

  it('locks the body while open and releases it when the dialog closes without unmounting', () => {
    const { rerender } = render(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);
    expect(document.body.style.overflow).toBe('hidden');

    rerender(<AddItemModal isOpen={false} onClose={onClose} onSuccess={onSuccess} />);
    expect(document.body.style.overflow).toBe('');
  });

  it('locks nothing while mounted closed and locks on open', () => {
    const { rerender } = render(<AddItemModal isOpen={false} onClose={onClose} onSuccess={onSuccess} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');

    rerender(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('keeps the ring tokens on the disabled submit control while an upload is in flight', () => {
    getUploadUrl.mockReturnValue(new Promise(() => {}));
    const { container } = render(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(input!, { target: { files: [new File(['x'], 'photo.jpg', { type: 'image/jpeg' })] } });
    fireEvent.submit(container.querySelector('form')!);

    const submit = screen.getByRole('button', { name: 'Uploading...' });
    expect(submit).toBeDisabled();
    expectRingTokens(submit);
    expectEveryStopRings(screen.getByRole('dialog', { name: 'Add Wardrobe Item' }));
  });

  // --- The batch path -------------------------------------------------------

  function photo(name: string) {
    return new File(['x'], name, { type: 'image/jpeg', lastModified: 1_700_000_000_000 });
  }

  function picker(container: HTMLElement) {
    return container.querySelector<HTMLInputElement>('#add-item-image')!;
  }

  function camera(container: HTMLElement) {
    return container.querySelector<HTMLInputElement>('#add-item-camera')!;
  }

  function rows() {
    return within(screen.getByRole('list', { name: 'Added photos' })).getAllByRole('listitem');
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  /** One reservation per photo, so a fresh reservation is visible as a new id. */
  function stubReservations() {
    getUploadUrl.mockImplementation(async (args: any) => ({
      reservationId: `reservation-${getUploadUrl.mock.calls.length}`,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      upload: {
        url: 'https://s3.example.com/upload',
        fields: { 'Content-Type': args?.data?.contentType ?? 'image/png' },
      },
    }));
    confirmUpload.mockImplementation(async ({ data }: any) => ({
      itemId: `item-${data.reservationId}`,
      taggingStatus: 'processing',
    }));
  }

  /** The direct S3 POST, stubbed: a name in `rejected` answers 403, everything else 204. */
  function stubSignedPost(rejected: string[] = []) {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const file = (init.body as FormData).get('file') as File;
      return (rejected.includes(file.name)
        ? { ok: false, status: 403 }
        : { ok: true, status: 204 }) as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('lists one row per selected photo, each naming its file', () => {
    const { container } = render(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);

    fireEvent.change(picker(container), {
      target: { files: [photo('shirt.png'), photo('jeans.png'), photo('boots.png')] },
    });

    const list = rows();
    expect(list).toHaveLength(3);
    expect(within(list[0]).getByText('shirt.png')).toBeInTheDocument();
    expect(within(list[1]).getByText('jeans.png')).toBeInTheDocument();
    expect(within(list[2]).getByText('boots.png')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add 3 items' })).toBeInTheDocument();
    // The picker keeps the existing contract and stays the first file input.
    const firstInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(firstInput).toBe(picker(container));
    expect(firstInput).toHaveAttribute('multiple');
    expect(firstInput).toHaveAttribute('id', 'add-item-image');
    expect(firstInput).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
    expect(firstInput).not.toHaveAttribute('capture');
    expect(screen.getByLabelText('Image Upload a file or take a photo')).toBe(firstInput);
  });

  it('appends one row per camera activation inside one open dialog', async () => {
    stubReservations();
    stubSignedPost();
    const { container } = render(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);
    const cameraInput = camera(container);
    expect(cameraInput).toHaveAttribute('capture', 'environment');
    expect(cameraInput.id).not.toBe('add-item-image');
    expect(screen.getByLabelText('Take a photo')).toBe(cameraInput);

    fireEvent.change(cameraInput, { target: { files: [photo('shot-one.png')] } });
    fireEvent.change(cameraInput, { target: { files: [photo('shot-two.png')] } });

    const list = rows();
    expect(list).toHaveLength(2);
    expect(within(list[0]).getByText('shot-one.png')).toBeInTheDocument();
    expect(within(list[1]).getByText('shot-two.png')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Add Wardrobe Item' })).toBeInTheDocument();

    // The two shots are one action: two reservations, two items, one open dialog.
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(screen.getByText('2 items added, 0 failed')).toBeInTheDocument());
    expect(getUploadUrl).toHaveBeenCalledTimes(2);
    expect(confirmUpload).toHaveBeenCalledTimes(2);
    const settled = rows();
    expect(settled).toHaveLength(2);
    expect(within(settled[0]).getByText('shot-one.png')).toBeInTheDocument();
    expect(within(settled[0]).getByText('Created')).toBeInTheDocument();
    expect(within(settled[0]).getByText('Item item-reservation-1')).toBeInTheDocument();
    expect(within(settled[1]).getByText('shot-two.png')).toBeInTheDocument();
    expect(within(settled[1]).getByText('Created')).toBeInTheDocument();
    expect(within(settled[1]).getByText('Item item-reservation-2')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Add Wardrobe Item' })).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('shows each row its own step while the photo runs', async () => {
    const reserveGate = deferred<any>();
    getUploadUrl.mockReturnValueOnce(reserveGate.promise);
    const uploadGate = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => uploadGate.promise));
    const confirmGate = deferred<any>();
    confirmUpload.mockReturnValueOnce(confirmGate.promise);

    const { container } = render(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);
    fireEvent.change(picker(container), { target: { files: [photo('coat.png')] } });
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(within(rows()[0]).getByText('Reserving')).toBeInTheDocument());

    reserveGate.resolve({
      reservationId: 'reservation-1',
      expiresAt: '2026-01-01T00:00:00.000Z',
      upload: { url: 'https://s3.example.com/upload', fields: {} },
    });
    await waitFor(() => expect(within(rows()[0]).getByText('Uploading')).toBeInTheDocument());

    uploadGate.resolve({ ok: true, status: 204 } as unknown as Response);
    await waitFor(() => expect(within(rows()[0]).getByText('Confirming')).toBeInTheDocument());

    confirmGate.resolve({ itemId: 'item-1', taggingStatus: 'processing' });
    await waitFor(() => expect(within(rows()[0]).getByText('Created')).toBeInTheDocument());
    expect(within(rows()[0]).getByText('Item item-1')).toBeInTheDocument();
    expect(within(rows()[0]).getByText('Tagging processing')).toBeInTheDocument();
  });

  it('keeps ten photos of eleven selected and says how many were not added', () => {
    const { container } = render(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);

    fireEvent.change(picker(container), {
      target: { files: Array.from({ length: 11 }, (_, index) => photo(`batch-${index}.png`)) },
    });

    expect(screen.getByText('10 of 11 selected — 1 was not added')).toBeInTheDocument();
    expect(rows()).toHaveLength(10);
    expect(screen.getByRole('button', { name: 'Add 10 items' })).toBeInTheDocument();
  });

  it('skips a duplicate selection and says so', () => {
    const { container } = render(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);

    fireEvent.change(picker(container), {
      target: { files: [photo('linen.png'), photo('linen.png'), photo('denim.png')] },
    });

    expect(screen.getByText('1 duplicate photo was skipped')).toBeInTheDocument();
    expect(rows()).toHaveLength(2);
  });

  it('summarises a settled batch and retries only the failed photo', async () => {
    stubReservations();
    stubSignedPost(['broken.png']);
    const { container } = render(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);

    fireEvent.change(picker(container), {
      target: { files: [photo('one.png'), photo('broken.png'), photo('three.png')] },
    });
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByText('2 items added, 1 failed')).toBeInTheDocument());
    const settledRows = rows();
    expect(within(settledRows[0]).getByText('Created')).toBeInTheDocument();
    expect(within(settledRows[1]).getByText('Failed')).toBeInTheDocument();
    expect(within(settledRows[1]).getByText('Image upload failed with HTTP 403')).toBeInTheDocument();
    expect(within(settledRows[2]).getByText('Created')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Add Wardrobe Item' })).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();

    const reservationsBefore = getUploadUrl.mock.calls.length;
    const confirmationsBefore = confirmUpload.mock.calls.length;
    stubSignedPost([]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed' }));

    await waitFor(() => expect(screen.getByText('3 items added, 0 failed')).toBeInTheDocument());
    // One fresh reservation, one post and one confirmation for the one failed row.
    expect(getUploadUrl.mock.calls.length).toBe(reservationsBefore + 1);
    expect(confirmUpload.mock.calls.length).toBe(confirmationsBefore + 1);
  });

  it('closes the dialog through onSuccess when the only photo succeeds', async () => {
    stubReservations();
    stubSignedPost();
    const { container } = render(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);

    fireEvent.change(picker(container), { target: { files: [photo('only.png')] } });
    expect(screen.getByRole('button', { name: 'Upload & Auto-Tag' })).toBeInTheDocument();
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(window.alert).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('raises the existing alert and keeps the dialog open when the only photo fails', async () => {
    getUploadUrl.mockRejectedValue(new Error('reserve failed'));
    const { container } = render(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);

    fireEvent.change(picker(container), { target: { files: [photo('only.png')] } });
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith('Failed to upload image: reserve failed');
    });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Add Wardrobe Item' })).toBeInTheDocument();
  });

  it('starts no photo that had not started when the dialog closes mid-run', async () => {
    const gates = [deferred<any>(), deferred<any>(), deferred<any>()];
    getUploadUrl.mockImplementation(() => gates[getUploadUrl.mock.calls.length - 1].promise);
    confirmUpload.mockImplementation(async ({ data }: any) => ({
      itemId: `item-${data.reservationId}`,
      taggingStatus: 'processing',
    }));
    stubSignedPost();
    const { container } = render(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);

    fireEvent.change(picker(container), {
      target: { files: [photo('one.png'), photo('two.png'), photo('three.png'), photo('four.png')] },
    });
    fireEvent.submit(container.querySelector('form')!);
    // Three slots started; the fourth photo is queued and holds no reservation.
    expect(getUploadUrl).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    gates.forEach((gate, index) => gate.resolve({
      reservationId: `reservation-${index + 1}`,
      expiresAt: '2026-01-01T00:00:00.000Z',
      upload: { url: 'https://s3.example.com/upload', fields: {} },
    }));

    // The in-flight photos settle and the queued one is never started.
    await waitFor(() => expect(confirmUpload).toHaveBeenCalledTimes(3));
    expect(getUploadUrl).toHaveBeenCalledTimes(3);
  });

  it('advances a created row from the page\u2019s live item tagging status', async () => {
    stubReservations();
    stubSignedPost();
    const onItemsCreated = vi.fn();
    const { container, rerender } = render(
      <AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} items={[]} onItemsCreated={onItemsCreated} />,
    );

    fireEvent.change(picker(container), { target: { files: [photo('one.png'), photo('two.png')] } });
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByText('2 items added, 0 failed')).toBeInTheDocument());
    expect(onItemsCreated).toHaveBeenCalledTimes(2);

    rerender(
      <AddItemModal
        isOpen
        onClose={onClose}
        onSuccess={onSuccess}
        items={[
          { id: 'item-reservation-1', taggingStatus: 'ready', taggingErrorCode: null },
          { id: 'item-reservation-2', taggingStatus: 'failed', taggingErrorCode: 'VLM_TIMEOUT' },
        ]}
        onItemsCreated={onItemsCreated}
      />,
    );

    await waitFor(() => expect(screen.getByText('Tagging ready')).toBeInTheDocument());
    expect(screen.getByText('Tagging failed (VLM_TIMEOUT)')).toBeInTheDocument();
  });

  it('disables every row\u2019s Remove control while the batch runs and frees a failed row once it settles', async () => {
    // Self-contained: this test declares the confirmation and S3 post it depends on.
    stubReservations();
    const gates = [deferred<any>(), deferred<any>(), deferred<any>()];
    getUploadUrl.mockImplementation(() => gates[getUploadUrl.mock.calls.length - 1].promise);
    stubSignedPost(['broken.png']);
    const { container } = render(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);

    fireEvent.change(picker(container), {
      target: { files: [photo('one.png'), photo('broken.png'), photo('three.png')] },
    });
    fireEvent.submit(container.querySelector('form')!);

    // Every row is one of the run's targets while it runs: removing one would
    // leave the runner uploading a photo the list no longer shows.
    const runningRows = rows();
    expect(runningRows).toHaveLength(3);
    for (const row of runningRows) {
      const remove = within(row).getByRole('button', { name: /^Remove / });
      expect(remove).toBeDisabled();
      // The disabled control keeps the dialog's ring tokens.
      expectRingTokens(remove);
    }

    gates.forEach((gate, index) => gate.resolve({
      reservationId: `reservation-${index + 1}`,
      expiresAt: '2026-01-01T00:00:00.000Z',
      upload: { url: 'https://s3.example.com/upload', fields: {} },
    }));

    await waitFor(() => expect(screen.getByText('2 items added, 1 failed')).toBeInTheDocument());

    const failedRow = rows()[1];
    expect(within(failedRow).getByText('broken.png')).toBeInTheDocument();
    const failedRemove = within(failedRow).getByRole('button', { name: 'Remove broken.png' });
    expect(failedRemove).toBeEnabled();

    fireEvent.click(failedRemove);

    // The settled row can be removed, and the summary recounts what is left.
    expect(rows()).toHaveLength(2);
    expect(screen.queryByText('broken.png')).toBeNull();
    expect(screen.getByText('2 items added, 0 failed')).toBeInTheDocument();
  });

  it('disables both file inputs while the batch runs and re-enables them once it settles', async () => {
    // Self-contained: the confirmation implementation is declared here, then the
    // reservation is gated so the run can be observed in flight.
    stubReservations();
    const gate = deferred<any>();
    getUploadUrl.mockImplementation(() => gate.promise);
    stubSignedPost();
    const { container } = render(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);

    fireEvent.change(picker(container), { target: { files: [photo('one.png'), photo('two.png')] } });
    fireEvent.submit(container.querySelector('form')!);

    expect(picker(container)).toBeDisabled();
    expect(camera(container)).toBeDisabled();
    // The label carries the busy affordance, and the ring tokens stay authored.
    for (const input of [picker(container), camera(container)]) {
      const label = input.closest('label')!;
      const tokens = label.className.split(/\s+/);
      expect(tokens).toContain('opacity-50');
      expect(tokens).toContain('cursor-not-allowed');
      expectRingTokens(label, 'focus-within:');
    }

    gate.resolve({
      reservationId: 'reservation-1',
      expiresAt: '2026-01-01T00:00:00.000Z',
      upload: { url: 'https://s3.example.com/upload', fields: {} },
    });

    await waitFor(() => expect(screen.getByText('2 items added, 0 failed')).toBeInTheDocument());
    expect(picker(container)).toBeEnabled();
    expect(camera(container)).toBeEnabled();
    expect(picker(container).closest('label')!.className.split(/\s+/)).toContain('cursor-pointer');
  });

  it('submits ten of eleven photos and sends no request for the eleventh', async () => {
    stubReservations();
    stubSignedPost();
    const { container } = render(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);

    fireEvent.change(picker(container), {
      target: { files: Array.from({ length: 11 }, (_, index) => photo(`batch-${index}.png`)) },
    });
    expect(screen.getByText('10 of 11 selected — 1 was not added')).toBeInTheDocument();

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByText('10 items added, 0 failed')).toBeInTheDocument());
    // The bound is applied to the request count, not only to the visible list.
    expect(getUploadUrl).toHaveBeenCalledTimes(10);
    expect(confirmUpload).toHaveBeenCalledTimes(10);
    expect(rows()).toHaveLength(10);
    // The eleventh photo never became a row and never caused a request.
    expect(screen.queryByText('batch-10.png')).toBeNull();
  });

  it('submits six of seven photos when their summed bytes exceed 60 MiB', async () => {
    stubReservations();
    stubSignedPost();
    const { container } = render(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);
    const tenMiB = 10 * 1024 * 1024;
    const files = Array.from({ length: 7 }, (_, index) => {
      // A real File with a shadowed size: the bound reads `file.size`, not the bytes.
      const file = photo(`large-${index}.png`);
      Object.defineProperty(file, 'size', { value: tenMiB });
      return file;
    });

    fireEvent.change(picker(container), { target: { files } });
    expect(screen.getByText('6 of 7 selected — 1 was not added')).toBeInTheDocument();

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByText('6 items added, 0 failed')).toBeInTheDocument());
    expect(getUploadUrl).toHaveBeenCalledTimes(6);
    expect(confirmUpload).toHaveBeenCalledTimes(6);
    expect(rows()).toHaveLength(6);
    expect(screen.queryByText('large-6.png')).toBeNull();
  });

  it('shows the wardrobe hint on a row whose confirmation outlived its automatic retry', async () => {
    stubReservations();
    stubSignedPost();
    confirmUpload.mockImplementation(async ({ data }: any) => {
      if (data.reservationId === 'reservation-1') {
        throw Object.assign(new Error('Request failed with status code 500'), {
          response: { status: 500 },
        });
      }
      return { itemId: `item-${data.reservationId}`, taggingStatus: 'processing' };
    });
    const { container } = render(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);

    fireEvent.change(picker(container), { target: { files: [photo('one.png'), photo('two.png')] } });
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByText('1 item added, 1 failed')).toBeInTheDocument());
    const failedRow = rows()[0];
    expect(within(failedRow).getByText('Failed')).toBeInTheDocument();
    expect(failedRow).toHaveTextContent(CONFIRM_CHECK_WARDROBE_HINT);
    // The 500 was answered twice, on the same reservation, before the row failed.
    expect(confirmUpload).toHaveBeenCalledTimes(3);
  });

  it('drops the bound message once that row is removed', () => {
    const { container } = render(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);

    fireEvent.change(picker(container), {
      target: { files: Array.from({ length: 11 }, (_, index) => photo(`batch-${index}.png`)) },
    });
    expect(screen.getByText('10 of 11 selected — 1 was not added')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove batch-0.png' }));

    // The remaining selection fits, so the message no longer describes it.
    expect(screen.queryByText('10 of 11 selected — 1 was not added')).toBeNull();
    expect(rows()).toHaveLength(9);
  });

  it('drops the duplicate message once the collapsed row is removed', () => {
    const { container } = render(<AddItemModal isOpen onClose={onClose} onSuccess={onSuccess} />);

    fireEvent.change(picker(container), {
      target: { files: [photo('linen.png'), photo('linen.png'), photo('denim.png')] },
    });
    expect(screen.getByText('1 duplicate photo was skipped')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove linen.png' }));

    expect(screen.queryByText('1 duplicate photo was skipped')).toBeNull();
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]).getByText('denim.png')).toBeInTheDocument();
  });
});
