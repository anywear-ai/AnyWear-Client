/**
 * The shell's long-press guard.
 *
 * CSS removes the iOS callout and the selection highlight (`index.css`), but
 * Android WebView still opens its own context menu for a long press on an image,
 * a link or a button. The Tauri shell therefore cancels the DOM `contextmenu`
 * event for every target that is not an editable field, where the same event is
 * the selection and paste affordance the user expects.
 */

/** True when a `contextmenu` event on this target should be cancelled. */
export function shouldBlockContextMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return target.closest('input, textarea, [contenteditable="true"]') === null;
}

/** Cancel the native long-press menu; returns the function that removes the guard. */
export function installContextMenuGuard(doc: Document = document): () => void {
  const guard = (event: Event) => {
    if (shouldBlockContextMenu(event.target)) event.preventDefault();
  };
  doc.addEventListener('contextmenu', guard);
  return () => doc.removeEventListener('contextmenu', guard);
}
