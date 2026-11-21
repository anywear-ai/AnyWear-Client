import { useState } from 'react';
import { usePatchOutfitsId, useDeleteOutfitsId } from '../../api/endpoints/outfits/outfits';
import type { GetOutfits200OutfitsItem } from '../../api/model/getOutfits200OutfitsItem';
import useAccessibleDialog from '../../hooks/useAccessibleDialog';
import { getHttpStatus } from '../../lib/errors';
import { outfitHasActiveGeneration } from '../../lib/outfit-look';

/**
 * Issue 334 — deleting an outfit removes the outfit, and nothing else.
 *
 * The copy says what actually happens: the card goes, the looks stay. It no
 * longer claims records or images are deleted, and it states how many try-on
 * records the outfit already has because that is the fact the user is weighing.
 * A true zero needs no number; a count the Service could not resolve keeps the
 * wording without inventing one.
 */
function deleteConfirmationCopy(outfit: GetOutfits200OutfitsItem): string {
  const count = outfit.generationCount;
  if (typeof count === 'number' && count > 0) {
    const records = count === 1 ? '1 try-on record' : `${count} try-on records`;
    return `Delete this outfit? It has ${records}. Its looks stay in your history. This cannot be undone.`;
  }
  if (count === 0) return 'Delete this outfit? Its looks stay in your history. This cannot be undone.';
  return 'Delete this outfit? Its looks stay in your history. This cannot be undone.';
}

/**
 * Issue 332 — the delete refuses while a try-on is running. The control is
 * disabled rather than offering a "delete anyway": the refusal costs nothing and
 * succeeds once the attempt settles, so forcing it is never the answer.
 */
const RUNNING_TRY_ON_COPY = 'A try-on is still running for this outfit. Wait for it to finish before deleting.';

/**
 * Issue 332 — a rename the Service refuses must be shown, not swallowed.
 *
 * The one refusal this delivery adds is the frozen-membership `400`: a build that
 * still sends `wearable_item_ids` gets `VALIDATION_ERROR` with the key named in
 * `details[].message`. The sentence states that the members cannot be changed, so
 * the user learns the rule rather than seeing "save failed".
 */
function describeOutfitSaveFailure(error: unknown): string {
  const status = getHttpStatus(error);
  if (status === 400) {
    return 'This outfit\'s items cannot be changed after it is created. Only the name can be saved; start a new try-on to use a different set of items.';
  }
  if (status === 404) return 'This outfit no longer exists.';
  if (typeof status === 'number') return `Save failed with status ${status}.`;
  return 'Save failed.';
}

/** The sentence a refused delete leaves beside its control. */
function describeOutfitDeleteFailure(error: unknown): string {
  const status = getHttpStatus(error);
  if (status === 409) {
    return 'A try-on is still running for this outfit. Wait for it to finish, then delete the outfit.';
  }
  if (status === 404) return 'This outfit no longer exists.';
  if (typeof status === 'number') return `Delete failed with status ${status}.`;
  return 'Delete failed.';
}

interface OutfitModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  /** The saved outfit, so the page can offer the confirmed look action right after a save. */
  onSaved?: (outfit: { id: string; name?: string | null }) => void;
  /** A delete the Service completed. */
  onNotice?: (notice: { deletedOutfit: true }) => void;
  outfit?: GetOutfits200OutfitsItem;
}

/**
 * Issue 313 — the saved-outfit dialog, and only that.
 *
 * The creation mode is gone: an outfit is composed in the Fitting Room, where the
 * staged set and the base photo live. What is left is the pair of actions the
 * Wardrobe keeps — rename and delete — over a read-only member list that marks the
 * pieces now in the Storage Box. The patch body is `{ name }` alone, so the frozen
 * membership is the Service's rule enforced by this client's shape.
 */
export default function OutfitModal({ isOpen, onClose, onSuccess, onSaved, onNotice, outfit }: OutfitModalProps) {
  const dialogRef = useAccessibleDialog(onClose, isOpen);
  const [name, setName] = useState(outfit?.name ?? '');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState<string | null>(null);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);

  const { mutate: updateOutfit, isPending: isUpdating } = usePatchOutfitsId();
  const { mutate: deleteOutfit, isPending: isDeleting } = useDeleteOutfitsId();

  const handleSubmit = () => {
    if (!outfit) return;
    setSaveFailure(null);
    updateOutfit(
      { id: outfit.id, data: { name: name.trim() || undefined } },
      {
        onSuccess: (saved) => {
          onSuccess();
          onSaved?.(saved);
          onClose();
        },
        onError: (error: unknown) => setSaveFailure(describeOutfitSaveFailure(error)),
      },
    );
  };

  const handleDelete = () => {
    if (!outfit) return;
    setDeleteFailure(null);
    deleteOutfit(
      { id: outfit.id },
      {
        onSuccess: () => {
          onNotice?.({ deletedOutfit: true });
          onSuccess();
          onClose();
        },
        onError: (error: unknown) => {
          const status = getHttpStatus(error);
          // A 404 is already deleted; that is a removal, not a failure.
          if (status === 404) {
            onNotice?.({ deletedOutfit: true });
            onSuccess();
            onClose();
            return;
          }
          setDeleteFailure(describeOutfitDeleteFailure(error));
        },
      },
    );
  };

  const isPending = isUpdating || isDeleting;
  const submitLabel = isUpdating ? 'Saving...' : 'Save Changes';
  const tryOnIsRunning = !!outfit && outfitHasActiveGeneration(outfit);
  const confirmationCopy = outfit ? deleteConfirmationCopy(outfit) : '';
  const members = outfit?.wearableItems ?? [];

  if (!isOpen || !outfit) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4">
        <div className="fixed inset-0 bg-gray-500/75" onClick={onClose} />
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="outfit-dialog-title" tabIndex={-1} className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-5 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 id="outfit-dialog-title" className="text-lg font-semibold text-gray-900">
              Edit Outfit
            </h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500">
              <span className="sr-only">Close</span>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="mb-4">
            <label htmlFor="outfit-dialog-name" className="block text-sm font-medium text-gray-700 mb-1">Outfit Name (optional)</label>
            <input
              type="text"
              id="outfit-dialog-name"
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Weekend Casual"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>

          <div className="mb-4">
            <div id="outfit-dialog-members-label" className="block text-sm font-medium text-gray-700 mb-2">
              Items in this outfit ({members.length})
            </div>
            <p className="mb-2 text-xs text-gray-500">
              An outfit's items are fixed when it is created. Start a new try-on to use a different set.
            </p>
            <ul
              aria-labelledby="outfit-dialog-members-label"
              className="max-h-64 overflow-y-auto space-y-1 border border-gray-200 rounded-lg p-2"
            >
              {members.length === 0 ? (
                <li className="py-4 text-center text-sm text-gray-400">This outfit has no items.</li>
              ) : (
                members.map((item) => (
                  <li key={item.id} data-testid="outfit-member" className="flex items-center gap-3 rounded-lg p-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{item.name || item.category || 'Unknown'}</span>
                    {item.archivedAt && (
                      <span
                        data-testid="outfit-member-archived"
                        className="inline-flex flex-shrink-0 items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
                      >
                        Archived
                      </span>
                    )}
                  </li>
                ))
              )}
            </ul>
          </div>

          {saveFailure && (
            <p role="alert" className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{saveFailure}</p>
          )}

          <div className="flex justify-between items-center">
            {showDeleteConfirm ? (
              <div className="flex flex-col gap-1">
                <span className="text-sm text-red-600">{confirmationCopy}</span>
                {tryOnIsRunning && (
                  <span className="text-sm text-red-600">{RUNNING_TRY_ON_COPY}</span>
                )}
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleDelete}
                    disabled={isDeleting || tryOnIsRunning}
                    className="px-3 py-1.5 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isDeleting ? 'Deleting...' : 'Confirm'}
                  </button>
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                  >
                    Cancel
                  </button>
                </div>
                {deleteFailure && (
                  <p role="alert" className="text-sm text-red-700">{deleteFailure}</p>
                )}
              </div>
            ) : (
              <button
                onClick={() => {
                  setDeleteFailure(null);
                  setShowDeleteConfirm(true);
                }}
                className="px-3 py-1.5 text-sm font-medium text-red-600 bg-red-50 rounded-lg hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                Delete Outfit
              </button>
            )}
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={isPending}
                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitLabel}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
