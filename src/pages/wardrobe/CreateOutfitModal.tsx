import { useState } from 'react';
import { usePostOutfits, usePatchOutfitsId, useDeleteOutfitsId } from '../../api/endpoints/outfits/outfits';
import { useGetWardrobe } from '../../api/endpoints/wardrobe/wardrobe';
import type { GetWardrobe200Item } from '../../api/model/getWardrobe200Item';
import type { GetOutfits200OutfitsItem } from '../../api/model/getOutfits200OutfitsItem';
import useAccessibleDialog from '../../hooks/useAccessibleDialog';

interface CreateOutfitModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  /** The saved outfit, so the page can offer the confirmed look action right after a save. */
  onSaved?: (outfit: { id: string; name?: string | null }) => void;
  outfit?: GetOutfits200OutfitsItem;
}

export default function CreateOutfitModal({ isOpen, onClose, onSuccess, onSaved, outfit }: CreateOutfitModalProps) {
  const dialogRef = useAccessibleDialog(onClose, isOpen);
  const isEditMode = !!outfit;
  const [name, setName] = useState(outfit?.name ?? '');
  const [selectedIds, setSelectedIds] = useState<string[]>(
    outfit?.wearableItems?.map((item) => item.id) ?? [],
  );
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

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
    deleteOutfit(
      { id: outfit.id },
      {
        onSuccess: () => {
          onSuccess();
          onClose();
        },
      },
    );
  };

  const isPending = isCreating || isUpdating || isDeleting;
  const submitLabel = isEditMode ? (isUpdating ? 'Saving...' : 'Save Changes') : (isCreating ? 'Creating...' : 'Create Outfit');

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
            <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">Outfit Name (optional)</label>
            <input
              type="text"
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Weekend Casual"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Select Items ({selectedIds.length} selected)
            </label>
            <div className="max-h-64 overflow-y-auto space-y-1 border border-gray-200 rounded-lg p-2">
              {wardrobeData.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">No items in wardrobe yet.</p>
              ) : (
                wardrobeData.map((item: GetWardrobe200Item) => {
                  const isSelected = selectedIds.includes(item.id);
                  return (
                    <button
                      key={item.id}
                      onClick={() => toggleItem(item.id)}
                      className={`w-full flex items-center gap-3 p-2 rounded-lg text-left text-sm transition-colors ${isSelected ? 'bg-indigo-50 border border-indigo-200' : 'hover:bg-gray-50 border border-transparent'}`}
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
                <div className="flex items-center gap-2">
                  <span className="text-sm text-red-600">Delete this outfit? This cannot be undone.</span>
                  <button
                    onClick={handleDelete}
                    disabled={isDeleting}
                    className="px-3 py-1.5 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50"
                  >
                    {isDeleting ? 'Deleting...' : 'Confirm'}
                  </button>
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="px-3 py-1.5 text-sm font-medium text-red-600 bg-red-50 rounded-lg hover:bg-red-100"
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
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={selectedIds.length === 0 || isPending}
                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
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
