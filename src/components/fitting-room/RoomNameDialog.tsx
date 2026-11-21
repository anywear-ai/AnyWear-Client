import { useState } from 'react';
import useAccessibleDialog from '../../hooks/useAccessibleDialog';

/** The Service's name bound, in UTF-16 code units, after trimming. */
export const ROOM_NAME_MAX_LENGTH = 200;

/** What the Service stores when a create names nothing. */
export const DEFAULT_ROOM_NAME = 'Fitting Room';

interface RoomNameDialogProps {
  isOpen: boolean;
  mode: 'create' | 'rename';
  initialName?: string;
  isSubmitting: boolean;
  errorMessage?: string | null;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

/** Why the submit is held, or null when the typed name is acceptable. */
function nameRefusal(mode: 'create' | 'rename', rawName: string): string | null {
  const name = rawName.trim();
  // A create with no name is not an error: the Service stores `Fitting Room` and
  // returns that row. A rename has to name something, so a blank one is refused
  // on the Client rather than by a round trip that writes nothing.
  if (name.length === 0) {
    return mode === 'create' ? null : `Enter a name of 1 to ${ROOM_NAME_MAX_LENGTH} characters.`;
  }
  if (name.length > ROOM_NAME_MAX_LENGTH) {
    return `A room name is at most ${ROOM_NAME_MAX_LENGTH} characters. Shorten it to save.`;
  }
  return null;
}

/**
 * Issue 313 — create and rename share one dialog.
 *
 * The requirement is the same in both directions (`1..200` UTF-16 code units after
 * trimming), so the submit stays disabled and the requirement is stated before the
 * request instead of letting the Service answer `400`. A create with a blank name
 * is the one asymmetry: it is a valid request that stores `Fitting Room`.
 *
 * The typed name starts from `initialName` at mount, so the page remounts it per
 * opening (a `key`) rather than resetting a state it does not own.
 */
export default function RoomNameDialog({
  isOpen,
  mode,
  initialName = '',
  isSubmitting,
  errorMessage,
  onSubmit,
  onCancel,
}: RoomNameDialogProps) {
  const dialogRef = useAccessibleDialog(onCancel, isOpen);
  const [name, setName] = useState(initialName);

  if (!isOpen) return null;

  const refusal = nameRefusal(mode, name);
  const title = mode === 'create' ? 'New fitting room' : 'Rename fitting room';
  const submitLabel = isSubmitting
    ? (mode === 'create' ? 'Creating...' : 'Saving...')
    : (mode === 'create' ? 'Create room' : 'Save name');

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="fixed inset-0 bg-gray-500/75" onClick={onCancel} />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="room-name-dialog-title"
          aria-describedby="room-name-dialog-requirement"
          tabIndex={-1}
          className="relative w-full max-w-md rounded-xl bg-white p-5 shadow-xl sm:p-6"
        >
          <h2 id="room-name-dialog-title" className="text-lg font-semibold text-gray-900">{title}</h2>
          <p id="room-name-dialog-requirement" className="mt-1 text-xs text-gray-600">
            {mode === 'create'
              ? `Leave the name blank to store it as “${DEFAULT_ROOM_NAME}”. A name is 1 to ${ROOM_NAME_MAX_LENGTH} characters.`
              : `A room name is 1 to ${ROOM_NAME_MAX_LENGTH} characters.`}
          </p>

          <label htmlFor="room-name-input" className="mt-4 block text-sm font-medium text-gray-700">
            Room name
          </label>
          <input
            id="room-name-input"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={DEFAULT_ROOM_NAME}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />

          {refusal && (
            <p role="alert" className="mt-2 text-xs text-red-600">{refusal}</p>
          )}
          {errorMessage && (
            <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</p>
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
              onClick={() => onSubmit(name)}
              disabled={isSubmitting || refusal !== null}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
