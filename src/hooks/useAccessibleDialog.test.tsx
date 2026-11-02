// @vitest-environment jsdom
import { StrictMode } from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, cleanup } from '@testing-library/react';
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
