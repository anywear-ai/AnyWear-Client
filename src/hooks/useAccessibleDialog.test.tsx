// @vitest-environment jsdom
import { StrictMode } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import useAccessibleDialog from './useAccessibleDialog';

interface DialogProps {
  label: string;
  enabled?: boolean;
}

function Dialog({ label, enabled }: DialogProps) {
  const dialogRef = useAccessibleDialog(() => {}, enabled);
  return (
    <div ref={dialogRef} role="dialog" aria-label={label} tabIndex={-1}>
      <button type="button">{label} action</button>
    </div>
  );
}

describe('useAccessibleDialog body scroll lock', () => {
  beforeEach(() => {
    cleanup();
    document.body.style.overflow = '';
  });

  afterEach(() => {
    cleanup();
    document.body.style.overflow = '';
  });

  it('locks the body for a default-enabled dialog and restores the empty inline value on unmount', () => {
    const { unmount } = render(<Dialog label="One" />);
    expect(document.body.style.overflow).toBe('hidden');

    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('keeps the lock until the last of two open dialogs closes', () => {
    const first = render(<Dialog label="One" />);
    const second = render(<Dialog label="Two" />);
    expect(document.body.style.overflow).toBe('hidden');

    first.unmount();
    expect(document.body.style.overflow).toBe('hidden');

    second.unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('restores a pre-existing non-default inline overflow exactly', () => {
    document.body.style.overflow = 'scroll';

    const { unmount } = render(<Dialog label="One" />);
    expect(document.body.style.overflow).toBe('hidden');

    unmount();
    expect(document.body.style.overflow).toBe('scroll');
  });

  it('locks nothing while disabled and locks once enabled', () => {
    const { rerender, unmount } = render(<Dialog label="One" enabled={false} />);
    expect(document.body.style.overflow).toBe('');

    rerender(<Dialog label="One" enabled />);
    expect(document.body.style.overflow).toBe('hidden');

    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('balances StrictMode mount, cleanup, and remount without drifting the counter', () => {
    const { unmount } = render(
      <StrictMode>
        <Dialog label="One" />
      </StrictMode>,
    );
    expect(document.body.style.overflow).toBe('hidden');

    unmount();
    expect(document.body.style.overflow).toBe('');

    // The second strict mount captures the value present now, not a stale one.
    document.body.style.overflow = 'clip';
    const second = render(
      <StrictMode>
        <Dialog label="Two" />
      </StrictMode>,
    );
    expect(document.body.style.overflow).toBe('hidden');

    second.unmount();
    expect(document.body.style.overflow).toBe('clip');
  });

  it('re-locks on a close and reopen without drifting the counter', () => {
    const first = render(<Dialog label="One" />);
    first.unmount();
    expect(document.body.style.overflow).toBe('');

    const second = render(<Dialog label="Two" />);
    expect(document.body.style.overflow).toBe('hidden');

    second.unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('restores focus to the control that opened the dialog', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = render(<Dialog label="One" />);
    expect(document.activeElement).not.toBe(opener);

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

/**
 * Two named controls, so the Tab-wrap assertions have a first and a last stop
 * that are distinct from the panel itself.
 */
function TwoControlDialog({ label, onClose }: { label: string; onClose: () => void }) {
  const dialogRef = useAccessibleDialog(onClose);
  return (
    <div ref={dialogRef} role="dialog" aria-label={label} tabIndex={-1}>
      <button type="button">{label} first</button>
      <button type="button">{label} last</button>
    </div>
  );
}

/** A panel whose content holds one focusable control: the wrap has nowhere to go. */
function OneControlDialog({ label, onClose }: { label: string; onClose: () => void }) {
  const dialogRef = useAccessibleDialog(onClose);
  return (
    <div ref={dialogRef} role="dialog" aria-label={label} tabIndex={-1}>
      <button type="button">{label} only</button>
    </div>
  );
}

describe('useAccessibleDialog Tab trap', () => {
  beforeEach(() => {
    cleanup();
    document.body.style.overflow = '';
  });

  afterEach(() => {
    cleanup();
    document.body.style.overflow = '';
  });

  it('wraps forward Tab from the last control to the first', () => {
    render(<TwoControlDialog label="Trap" onClose={() => {}} />);
    const first = document.querySelector<HTMLElement>('[aria-label="Trap"] button:first-of-type')!;
    const last = document.querySelectorAll<HTMLElement>('[aria-label="Trap"] button')[1]!;

    last.focus();
    expect(document.activeElement).toBe(last);

    // The document-level listener prevents the default move and places focus
    // itself, which is what makes the trap hold rather than leaving the panel.
    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(first);
  });

  it('wraps backward from the first control to the last on Shift+Tab', () => {
    render(<TwoControlDialog label="Trap" onClose={() => {}} />);
    const first = document.querySelector<HTMLElement>('[aria-label="Trap"] button:first-of-type')!;
    const last = document.querySelectorAll<HTMLElement>('[aria-label="Trap"] button')[1]!;

    first.focus();

    expect(fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);
  });

  it('keeps the single control of a one-control dialog and prevents the default', () => {
    render(<OneControlDialog label="Solo" onClose={() => {}} />);
    const only = document.querySelector<HTMLElement>('[aria-label="Solo"] button')!;

    expect(document.activeElement).toBe(only);

    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(only);

    expect(fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(only);
  });

  it('brings focus back into the panel when Tab starts outside it', () => {
    render(<TwoControlDialog label="Trap" onClose={() => {}} />);
    const first = document.querySelector<HTMLElement>('[aria-label="Trap"] button:first-of-type')!;
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(first);
    outside.remove();
  });
});

describe('useAccessibleDialog Escape', () => {
  beforeEach(() => {
    cleanup();
    document.body.style.overflow = '';
  });

  afterEach(() => {
    cleanup();
    document.body.style.overflow = '';
  });

  it('invokes the mounted dialog close callback exactly once per Escape', () => {
    const onClose = vi.fn();
    render(<TwoControlDialog label="Close" onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('removes its Escape listener on unmount, so a later dialog receives only its own Escape', () => {
    const firstClose = vi.fn();
    const first = render(<TwoControlDialog label="First" onClose={firstClose} />);
    first.unmount();

    // The unmounted dialog's listener is gone: this Escape belongs to the new one only.
    const secondClose = vi.fn();
    render(<TwoControlDialog label="Second" onClose={secondClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(firstClose).not.toHaveBeenCalled();
    expect(secondClose).toHaveBeenCalledTimes(1);
  });
});
