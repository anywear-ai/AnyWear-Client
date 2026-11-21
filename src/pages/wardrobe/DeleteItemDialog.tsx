import useAccessibleDialog from '../../hooks/useAccessibleDialog';
import type { GetWardrobeItemsItemIdDependentOutfits200OutfitsItem } from '../../api/model/getWardrobeItemsItemIdDependentOutfits200OutfitsItem';

interface DeleteItemDialogProps {
  isOpen: boolean;
  /** The item's generated name, its category, or neither. */
  itemName?: string | null;
  itemCategory?: string | null;
  /**
   * The outfits this delete removes with the item, already paged to the Service's
   * exact `total` (issue 332). Null while the preview is still loading or after it
   * failed: the confirm control stays disabled until the whole list is present,
   * because a truncated page could hide an outfit the user is about to lose.
   */
  dependentOutfits: GetWardrobeItemsItemIdDependentOutfits200OutfitsItem[] | null;
  /** The Service's exact dependency count; confirmation needs every entry. */
  dependentTotal: number | null;
  /** Whether the dependency preview failed to load; the confirm control stays disabled. */
  previewFailed: boolean;
  /** Whether the DELETE is out; the panel stays up and cannot be dismissed. */
  isSubmitting: boolean;
  /** The refused delete's sentence, rendered beside the control that sent it. */
  failureMessage?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  onRetryPreview: () => void;
}

/** The named thing in the body: the item's own name, then its category, then the neutral word. */
function itemLabel(itemName?: string | null, itemCategory?: string | null): string {
  return itemName || itemCategory || 'This item';
}

/** The one paragraph that states what the delete removes and what it keeps. */
function confirmationCopy(label: string, count: number): string {
  const outfits = count === 1 ? '1 outfit' : `${count} outfits`;
  return `Deleting ${label} also deletes ${outfits}: the saved combinations are removed. Their try-on records and images stay in your history. This cannot be undone.`;
}

/**
 * The Storage Box card's delete confirmation, rendered by the page rather than a
 * host script dialog, so the browser, Windows, macOS and Android builds all ask
 * the same question and all paint the same refusal.
 *
 * Issue 332 — the panel is a preview, not a warning after the fact. It lists every
 * outfit that goes with the item and each one's existing try-on count, it cannot
 * confirm until the preview has paged to the Service's exact `total`, and any
 * outfit with a running try-on disables confirmation outright. There is no
 * "delete anyway": the Service refuses in that case anyway, and the same request
 * succeeds once the attempt settles.
 *
 * Nothing is sent while this is open: `Delete permanently` is the only action that
 * issues the request, and `Cancel`, the backdrop and Escape all close without one.
 */
export default function DeleteItemDialog({
  isOpen,
  itemName,
  itemCategory,
  dependentOutfits,
  dependentTotal,
  previewFailed,
  isSubmitting,
  failureMessage,
  onCancel,
  onConfirm,
  onRetryPreview,
}: DeleteItemDialogProps) {
  // The hook owns Escape, the Tab trap, the counted body lock and focus return.
  // The close callback is the guard for all four: a pending delete refuses to
  // leave the panel.
  const dialogRef = useAccessibleDialog(() => {
    if (!isSubmitting) onCancel();
  }, isOpen);

  if (!isOpen) return null;

  const label = itemLabel(itemName, itemCategory);
  const outfits = dependentOutfits ?? [];
  const total = dependentTotal ?? 0;
  // The preview is complete only when every dependent outfit the Service counts
  // is present; until then the user cannot have seen what goes.
  const previewComplete = !previewFailed && dependentTotal !== null
    && dependentOutfits !== null && outfits.length === total;
  const runningTryOn = outfits.find((outfit) => outfit.hasActiveGeneration) ?? null;
  const canConfirm = previewComplete && !runningTryOn && !isSubmitting;

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
          className="relative w-full max-w-lg rounded-xl bg-white p-5 shadow-xl sm:p-6"
        >
          <h2 id="delete-item-dialog-title" className="text-lg font-semibold text-gray-900">
            Delete this item permanently?
          </h2>
          <p id="delete-item-dialog-description" className="mt-2 text-sm text-gray-600">
            {previewFailed
              ? `The outfits that use ${label} could not be listed, so this delete cannot continue.`
              : previewComplete
                ? total === 0
                  ? `${label} will be removed from the Storage Box. This cannot be undone.`
                  : confirmationCopy(label, total)
                : `Reading the outfits that use ${label}...`}
          </p>

          {previewFailed && (
            <div className="mt-3 rounded-lg bg-red-50 px-3 py-2">
              <p role="alert" className="text-sm text-red-700">
                The affected outfits could not be read, so nothing can be deleted yet.
              </p>
              <button
                type="button"
                onClick={onRetryPreview}
                className="mt-2 rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-red-700 ring-1 ring-inset ring-red-200 hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                Try again
              </button>
            </div>
          )}

          {previewComplete && outfits.length > 0 && (
            <ul data-testid="dependent-outfits" className="mt-3 max-h-56 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-2">
              {outfits.map((outfit) => (
                <li key={outfit.id} data-testid="dependent-outfit" className="flex items-center justify-between gap-3 rounded-lg p-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-gray-900">{outfit.name || 'Untitled outfit'}</span>
                  <span className="flex flex-shrink-0 items-center gap-2 text-xs text-gray-500">
                    <span data-testid="dependent-outfit-record-count">
                      {outfit.generationCount === 1 ? '1 try-on' : `${outfit.generationCount} try-ons`}
                    </span>
                    {outfit.hasActiveGeneration && (
                      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
                        Running
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {runningTryOn && (
            <p data-testid="running-try-on-notice" role="status" className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {runningTryOn.name || 'An outfit in this list'} has a try-on still running. Wait for it to
              finish, then delete this item. There is no way to delete it now.
            </p>
          )}

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
              disabled={!canConfirm}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? 'Deleting...' : 'Delete permanently'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
