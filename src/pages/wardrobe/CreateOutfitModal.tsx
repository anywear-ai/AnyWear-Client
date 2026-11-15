import { useState } from 'react';
import { usePostOutfits, usePatchOutfitsId, useDeleteOutfitsId } from '../../api/endpoints/outfits/outfits';
import { useGetWardrobe } from '../../api/endpoints/wardrobe/wardrobe';
import type { GetWardrobe200Item } from '../../api/model/getWardrobe200Item';
import type { GetOutfits200OutfitsItem } from '../../api/model/getOutfits200OutfitsItem';
import type { DeleteOutfitsId502 } from '../../api/model/deleteOutfitsId502';
import useAccessibleDialog from '../../hooks/useAccessibleDialog';
import { getHttpStatus } from '../../lib/errors';
import { outfitHasActiveGeneration } from '../../lib/outfit-look';

/**
 * The confirmation states one number, the generation count the Service reports
 * as the generations this delete removes. A true zero is not a number the user
 * needs, so it keeps the plain sentence; a count the Service could not resolve
 * keeps the wording without inventing one.
 */
function deleteConfirmationCopy(outfit: GetOutfits200OutfitsItem): string {
  const count = outfit.generationCount;
  if (typeof count === 'number' && count > 0) {
    const records = count === 1 ? '1 try-on record' : `${count} try-on records`;
    return `Delete this outfit? This also deletes its ${records} and their images. This cannot be undone.`;
  }
  if (count === 0) return 'Delete this outfit? This cannot be undone.';
  return 'Delete this outfit? This also deletes its try-on records and images. This cannot be undone.';
}

/** The fact a delete adds to the confirmation while a generation is running. */
const RUNNING_TRY_ON_COPY = 'A try-on that is still running is cancelled and its credit is not returned.';

/**
 * The Service's `502 OBJECT_DELETION_INCOMPLETE` body, read from the axios
 * rejection. Those rows are deleted; the retained keys are still owed by an
 * open cleanup manifest, so this is a completed delete from the caller's view.
 * The generated error type keeps the member names aligned with the contract.
 */
function objectDeletionIncomplete(error: unknown): DeleteOutfitsId502 | null {
  if (typeof error !== 'object' || error === null) return null;
  const response = (error as { response?: { status?: number; data?: unknown } }).response;
  if (response?.status !== 502) return null;
  const data = response.data as Partial<DeleteOutfitsId502> | null | undefined;
  return data?.error === 'OBJECT_DELETION_INCOMPLETE' ? (data as DeleteOutfitsId502) : null;
}

interface CreateOutfitModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  /** The saved outfit, so the page can offer the confirmed look action right after a save. */
  onSaved?: (outfit: { id: string; name?: string | null }) => void;
  /** A delete the Service completed while it still owes stored-image cleanup. */
  onNotice?: (notice: { retainedObjectKeys: number }) => void;
  outfit?: GetOutfits200OutfitsItem;
}

export default function CreateOutfitModal({ isOpen, onClose, onSuccess, onSaved, onNotice, outfit }: CreateOutfitModalProps) {
  const dialogRef = useAccessibleDialog(onClose, isOpen);
  const isEditMode = !!outfit;
  const [name, setName] = useState(outfit?.name ?? '');
  const [selectedIds, setSelectedIds] = useState<string[]>(
    outfit?.wearableItems?.map((item) => item.id) ?? [],
  );
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState<string | null>(null);

  const { data: wardrobeResponse } = useGetWardrobe({});
  const { mutate: createOutfit, isPending: isCreating } = usePostOutfits();
  const { mutate: updateOutfit, isPending: isUpdating } = usePatchOutfitsId();
  const { mutate: deleteOutfit, isPending: isDeleting } = useDeleteOutfitsId();

  const wardrobeData: GetWardrobe200Item[] = Array.isArray(wardrobeResponse) ? wardrobeResponse : [];

  const toggleItem = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
  };

  const handleSubmit = () => {
    if (selectedIds.length === 0) return;

    if (isEditMode) {
      updateOutfit(
        { id: outfit.id, data: { name: name.trim() || undefined, wearable_item_ids: selectedIds } },
        {
          onSuccess: (saved) => {
            onSuccess();
            onSaved?.(saved);
            onClose();
          },
        },
      );
    } else {
      createOutfit(
        { data: { name: name.trim() || undefined, wearable_item_ids: selectedIds } },
        {
          onSuccess: (saved) => {
            setName('');
            setSelectedIds([]);
            onSuccess();
            onSaved?.(saved);
            onClose();
          },
        },
      );
    }
  };

  const handleDelete = () => {
    if (!outfit) return;
    setDeleteFailure(null);
    deleteOutfit(
      { id: outfit.id },
      {
        onSuccess: () => {
          onSuccess();
          onClose();
        },
        onError: (error: unknown) => {
          const status = getHttpStatus(error);
          // A 404 is already deleted; a 502 OBJECT_DELETION_INCOMPLETE deleted
          // every row and still owes stored-image cleanup to the worker reaper.
          // Both finish the delete for the user, so neither is a failure here.
          if (status === 404) {
            onSuccess();
            onClose();
            return;
          }
          const incomplete = objectDeletionIncomplete(error);
          if (incomplete) {
            const retained = incomplete.details?.retained_object_keys;
            const retainedObjectKeys = Array.isArray(retained) ? retained.length : 0;
            if (retainedObjectKeys > 0) onNotice?.({ retainedObjectKeys });
            onSuccess();
            onClose();
            return;
          }
          // Anything else keeps the dialog open with a sentence naming the
          // status, so the user can see what happened; no retry control is added.
          setDeleteFailure(typeof status === 'number' ? `Delete failed with status ${status}.` : 'Delete failed.');
        },
      },
    );
  };

  const isPending = isCreating || isUpdating || isDeleting;
  const submitLabel = isEditMode ? (isUpdating ? 'Saving...' : 'Save Changes') : (isCreating ? 'Creating...' : 'Create Outfit');
  const showsRunningTryOn = !!outfit && outfitHasActiveGeneration(outfit);
  const confirmationCopy = outfit ? deleteConfirmationCopy(outfit) : '';

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4">
        <div className="fixed inset-0 bg-gray-500/75" onClick={onClose} />
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="outfit-dialog-title" tabIndex={-1} className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-5 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 id="outfit-dialog-title" className="text-lg font-semibold text-gray-900">
              {isEditMode ? 'Edit Outfit' : 'Create Outfit'}
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
            <div id="outfit-dialog-items-label" className="block text-sm font-medium text-gray-700 mb-2">
              Select Items ({selectedIds.length} selected)
            </div>
            <div role="group" aria-labelledby="outfit-dialog-items-label" className="max-h-64 overflow-y-auto space-y-1 border border-gray-200 rounded-lg p-2">
              {wardrobeData.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">No items in wardrobe yet.</p>
              ) : (
                wardrobeData.map((item: GetWardrobe200Item) => {
                  const isSelected = selectedIds.includes(item.id);
                  return (
                    <button
                      key={item.id}
                      onClick={() => toggleItem(item.id)}
                      className={`w-full flex items-center gap-3 p-2 rounded-lg text-left text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500 ${isSelected ? 'bg-indigo-50 border border-indigo-200' : 'hover:bg-gray-50 border border-transparent'}`}
                    >
                      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${isSelected ? 'bg-indigo-600 border-indigo-600' : 'border-gray-300'}`}>
                        {isSelected && (
                          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                      <span className="truncate">{item.name || item.category || 'Unknown'}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="flex justify-between items-center">
            {isEditMode ? (
              showDeleteConfirm ? (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-red-600">{confirmationCopy}</span>
                    <button
                      onClick={handleDelete}
                      disabled={isDeleting}
                      className="px-3 py-1.5 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
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
                  {showsRunningTryOn && (
                    <span className="text-sm text-red-600">{RUNNING_TRY_ON_COPY}</span>
                  )}
                  {deleteFailure && (
                    <p role="alert" className="text-sm text-red-700">{deleteFailure}</p>
                  )}
                </div>
              ) : (
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="px-3 py-1.5 text-sm font-medium text-red-600 bg-red-50 rounded-lg hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  Delete Outfit
                </button>
              )
            ) : (
              <div />
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
                disabled={selectedIds.length === 0 || isPending}
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
