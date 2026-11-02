// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, fireEvent, cleanup, waitFor, screen, within } from '@testing-library/react';

vi.mock('../../api/endpoints/wardrobe/wardrobe', () => ({
  usePostWardrobeUploadUrl: vi.fn(),
  usePostWardrobeUpload: vi.fn(),
}));

import AddItemModal from './AddItemModal';
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
    document.body.style.overflow = '';
    vi.mocked(usePostWardrobeUploadUrl).mockReturnValue({ mutateAsync: getUploadUrl } as any);
    vi.mocked(usePostWardrobeUpload).mockReturnValue({ mutateAsync: confirmUpload } as any);
    vi.spyOn(window, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    document.body.style.overflow = '';
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
});
