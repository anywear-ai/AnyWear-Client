// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { installContextMenuGuard, shouldBlockContextMenu } from './touch';

/** Dispatch a cancelable, bubbling `contextmenu` and report what the page did. */
function longPress(target: Element): boolean {
  const event = new Event('contextmenu', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('contextmenu guard', () => {
  let uninstall: (() => void) | null = null;

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    document.body.innerHTML = '';
  });

  it('cancels the long-press menu on imagery, links and controls', () => {
    uninstall = installContextMenuGuard();

    for (const tag of ['img', 'a', 'button'] as const) {
      const target = document.createElement(tag);
      document.body.append(target);
      expect(longPress(target), `${tag} kept its native menu`).toBe(true);
    }
  });

  it('leaves the menu on editable fields so text can be selected and pasted', () => {
    uninstall = installContextMenuGuard();
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.append(input, textarea, editable);

    expect(longPress(input)).toBe(false);
    expect(longPress(textarea)).toBe(false);
    expect(longPress(editable)).toBe(false);
  });

  it('blocks a non-element target rather than letting it through', () => {
    expect(shouldBlockContextMenu(document)).toBe(true);
    expect(shouldBlockContextMenu(null)).toBe(true);
  });

  it('stops cancelling once uninstalled', () => {
    const remove = installContextMenuGuard();
    const image = document.createElement('img');
    document.body.append(image);

    remove();

    expect(longPress(image)).toBe(false);
  });
});
