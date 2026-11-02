import useAccessibleDialog from '../../hooks/useAccessibleDialog';

interface GenerateLookDialogProps {
  isOpen: boolean;
  outfitName?: string | null;
  isSubmitting: boolean;
  errorMessage?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * The one place a look generation can be started from the Wardrobe.
 *
 * Nothing is requested while this is open; confirming is the first and only
 * action that spends a credit, and it states that cost before the request. Cancel,
 * the backdrop and Escape all close without calling the API.
 */
export default function GenerateLookDialog({
  isOpen,
  outfitName,
  isSubmitting,
  errorMessage,
  onCancel,
  onConfirm,
}: GenerateLookDialogProps) {
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
          aria-labelledby="generate-look-dialog-title"
          aria-describedby="generate-look-dialog-description"
          tabIndex={-1}
          className="relative w-full max-w-md rounded-xl bg-white p-5 shadow-xl sm:p-6"
        >
          <h2 id="generate-look-dialog-title" className="text-lg font-semibold text-gray-900">
            Generate a look for {outfitName || 'this outfit'}?
          </h2>
          <p id="generate-look-dialog-description" className="mt-2 text-sm text-gray-600">
            This uses 1 of your daily credits. The Wardrobe shows the result when it is ready.
          </p>

          {errorMessage && (
            <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {errorMessage}
            </p>
          )}

          <div className="mt-5 flex justify-end gap-3">
            <button
              type="button"
              onClick={onCancel}
              disabled={isSubmitting}
              className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={isSubmitting}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? 'Starting...' : 'Generate look (1 credit)'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
