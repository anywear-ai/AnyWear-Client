import useAccessibleDialog from '../../hooks/useAccessibleDialog';

interface DeleteItemDialogProps {
  isOpen: boolean;
  /** The item's generated name, its category, or neither. */
  itemName?: string | null;
  itemCategory?: string | null;
  /** Whether the DELETE is out; the panel stays up and cannot be dismissed. */
  isSubmitting: boolean;
  /** The refused delete's sentence, rendered beside the control that sent it. */
  failureMessage?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/** The named thing in C1's body: the item's own name, then its category, then the neutral word. */
function itemLabel(itemName?: string | null, itemCategory?: string | null): string {
  return itemName || itemCategory || 'This item';
}

/**
 * The grid card's delete confirmation, rendered by the page rather than a host
 * script dialog, so the browser, Windows, macOS and Android builds all ask the
 * same question and all paint the same refusal.
 *
 * Nothing is sent while this is open: `Delete item` is the only action that
 * issues the request, and `Cancel`, the backdrop and Escape all close without
 * one. While the request is out every exit is inert and the affirmative reads
 * `Deleting...`, so one confirmation can never issue two deletes and the
 * outcome always has a surface to land in.
 */
export default function DeleteItemDialog({
  isOpen,
  itemName,
  itemCategory,
  isSubmitting,
  failureMessage,
  onCancel,
  onConfirm,
}: DeleteItemDialogProps) {
  // The hook owns Escape, the Tab trap, the counted body lock and focus return.
  // The close callback is the guard for all four: a pending delete refuses to
  // leave the panel.
  const dialogRef = useAccessibleDialog(() => {
    if (!isSubmitting) onCancel();
  }, isOpen);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-screen items-center justify-center px-4">
        <div
          data-testid="delete-item-dialog-backdrop"
          className="fixed inset-0 bg-gray-500/75"
          onClick={() => {
            if (!isSubmitting) onCancel();
          }}
        />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-item-dialog-title"
          aria-describedby="delete-item-dialog-description"
          tabIndex={-1}
          className="relative w-full max-w-md rounded-xl bg-white p-5 shadow-xl sm:p-6"
        >
          <h2 id="delete-item-dialog-title" className="text-lg font-semibold text-gray-900">
            Delete this item?
          </h2>
          <p id="delete-item-dialog-description" className="mt-2 text-sm text-gray-600">
            {itemLabel(itemName, itemCategory)} will be removed from your wardrobe. This cannot be undone.
          </p>

          {failureMessage && (
            <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {failureMessage}
            </p>
          )}

          <div className="mt-5 flex justify-end gap-3">
            <button
              type="button"
              onClick={onCancel}
              disabled={isSubmitting}
              className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={isSubmitting}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? 'Deleting...' : 'Delete item'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
