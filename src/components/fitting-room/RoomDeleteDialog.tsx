import useAccessibleDialog from '../../hooks/useAccessibleDialog';

interface RoomDeleteDialogProps {
  isOpen: boolean;
  roomName?: string | null;
  isSubmitting: boolean;
  errorMessage?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Issue 313 — deleting a room asks first, in the app's own dialog.
 *
 * The question states exactly what the delete does: the room and its staged rows
 * go, the pieces stay in the wardrobe, and no other room changes. Nothing is sent
 * until the affirmative is pressed, and the cancel path returns focus to the
 * control that opened it through the shared dialog hook.
 */
export default function RoomDeleteDialog({
  isOpen,
  roomName,
  isSubmitting,
  errorMessage,
  onCancel,
  onConfirm,
}: RoomDeleteDialogProps) {
  const dialogRef = useAccessibleDialog(onCancel, isOpen);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="fixed inset-0 bg-gray-500/75" onClick={onCancel} />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="room-delete-dialog-title"
          aria-describedby="room-delete-dialog-description"
          tabIndex={-1}
          className="relative w-full max-w-md rounded-xl bg-white p-5 shadow-xl sm:p-6"
        >
          <h2 id="room-delete-dialog-title" className="text-lg font-semibold text-gray-900">
            Delete {roomName || 'this room'}?
          </h2>
          <p id="room-delete-dialog-description" className="mt-2 text-sm text-gray-600">
            The room and the pieces staged in it are removed. The pieces stay in your wardrobe, and
            your other rooms are untouched. This cannot be undone.
          </p>

          {errorMessage && (
            <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</p>
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
              {isSubmitting ? 'Deleting...' : 'Delete room'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
