import { useState, useRef } from 'react';
import { usePostWardrobeUploadUrl, usePostWardrobeUpload } from '../../api/endpoints/wardrobe/wardrobe';
import { uploadImageWithSignedPost, resolveImageContentType, validateImageFile } from '../../lib/imageUpload';
import { getErrorMessage } from '../../lib/errors';
import useAccessibleDialog from '../../hooks/useAccessibleDialog';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function AddItemModal({ isOpen, onClose, onSuccess }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useAccessibleDialog(onClose);

  const { mutateAsync: getUploadUrl } = usePostWardrobeUploadUrl();
  const { mutateAsync: confirmUpload } = usePostWardrobeUpload();

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;

    setIsUploading(true);
    try {
      validateImageFile(file);

      // 1. Reserve the upload. No wardrobe item exists yet: the reservation
      // records the key, the content type and the deadline the service will
      // hold this upload to.
      const reservation = await getUploadUrl({
        data: { contentType: resolveImageContentType(file) },
      });

      const { reservationId, upload } = reservation;

      if (!reservationId || !upload?.url) {
        throw new Error('Failed to reserve the upload');
      }

      // 2. Upload to S3 through the signed policy, which refuses a body over the
      // size ceiling or of a different content type.
      await uploadImageWithSignedPost(upload, file);

      // 3. Confirm: the service reads the stored object back, creates the item
      // and only then starts auto-tagging.
      await confirmUpload({
        data: { reservationId },
      });

      // Close modal — auto-tagging runs async, wardrobe list will show 'processing' status
      onSuccess();
    } catch (error) {
      console.error('Failed to add item:', error);
      const errorMessage = getErrorMessage(error, 'Unknown error');
      alert(`Failed to upload image: ${errorMessage}`);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-10 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:p-0">
        <div className="fixed inset-0 transition-opacity bg-gray-500/75" onClick={onClose} />

        <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="add-item-title" tabIndex={-1} className="relative inline-block px-4 pt-5 pb-4 overflow-hidden text-left align-bottom transition-all transform bg-white rounded-xl shadow-xl sm:my-8 sm:align-middle sm:max-w-lg sm:w-full sm:p-6">
          <div className="absolute top-0 right-0 pt-4 pr-4">
            <button
              onClick={onClose}
              className="text-gray-400 bg-white rounded-md hover:text-gray-500 focus:outline-none"
            >
              <span className="sr-only">Close</span>
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="sm:flex sm:items-start">
            <div className="w-full mt-3 text-center sm:mt-0 sm:text-left">
              <h3 id="add-item-title" className="text-lg font-medium leading-6 text-gray-900">Add Wardrobe Item</h3>
              <p className="mt-1 text-sm text-gray-500">
                Upload a photo and AI will automatically tag the item with category, color, material, and more.
              </p>

              <form onSubmit={handleSubmit} className="mt-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Image</label>
                  <div className="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-gray-300 border-dashed rounded-md">
                    <div className="space-y-1 text-center">
                      <svg className="mx-auto h-12 w-12 text-gray-400" stroke="currentColor" fill="none" viewBox="0 0 48 48">
                        <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <div className="flex text-sm text-gray-600 justify-center">
                        <label className="relative cursor-pointer bg-white rounded-md font-medium text-indigo-600 hover:text-indigo-500 focus-within:outline-none focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-indigo-500">
                          <span>Upload a file or take a photo</span>
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            capture="environment"
                            className="sr-only"
                            onChange={(e) => {
                              if (e.target.files && e.target.files[0]) {
                                setFile(e.target.files[0]);
                              }
                            }}
                          />
                        </label>
                      </div>
                      <p className="text-xs text-gray-500">PNG, JPG or WebP up to 10MB</p>
                    </div>
                  </div>
                  {file && (
                    <p className="mt-2 text-sm text-gray-500">Selected: {file.name}</p>
                  )}
                </div>

                <div className="mt-5 sm:mt-4 sm:flex sm:flex-row-reverse">
                  <button
                    type="submit"
                    disabled={isUploading || !file}
                    className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-indigo-600 text-base font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 sm:ml-3 sm:w-auto sm:text-sm disabled:opacity-50"
                  >
                    {isUploading ? 'Uploading...' : 'Upload & Auto-Tag'}
                  </button>
                  <button
                    type="button"
                    onClick={onClose}
                    className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 sm:mt-0 sm:w-auto sm:text-sm"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
