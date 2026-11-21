import type { GetFittingRooms200FittingRoomsItem } from '../../api/model/getFittingRooms200FittingRoomsItem';

interface RoomSwitcherProps {
  /** The list in the Service's order: the default room is first. */
  rooms: GetFittingRooms200FittingRoomsItem[];
  selectedRoomId: string | null;
  onSelect: (roomId: string) => void;
  onCreate: () => void;
  onRename: () => void;
  onDelete: () => void;
  isBusy?: boolean;
}

/**
 * Issue 313 — the room switcher, directly below the page heading.
 *
 * It lists the caller's rooms in the order the Service returns them (`isDefault`
 * first) and switching only changes which `fitting_room_id` the page reads: it
 * writes no row, stages nothing and clears nothing. `New room`, `Rename` and
 * `Delete` sit beside it because all three act on the room that is open.
 */
export default function RoomSwitcher({
  rooms,
  selectedRoomId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  isBusy = false,
}: RoomSwitcherProps) {
  const hasRooms = rooms.length > 0;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="group"
          aria-label="Fitting rooms"
          className="flex flex-wrap items-center gap-1.5"
        >
          {rooms.map((room) => {
            const isSelected = room.id === selectedRoomId;
            return (
              <button
                key={room.id}
                type="button"
                onClick={() => onSelect(room.id)}
                aria-pressed={isSelected}
                className={`rounded-full px-3 py-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 ${
                  isSelected ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {room.name}
                <span className="ml-1 text-xs font-normal opacity-80">{room.itemCount}</span>
              </button>
            );
          })}
          {!hasRooms && <p className="text-sm text-gray-600">No room yet. The next read creates a default one.</p>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onCreate}
            disabled={isBusy}
            className="rounded-md bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            New room
          </button>
          <button
            type="button"
            onClick={onRename}
            disabled={isBusy || !selectedRoomId}
            className="rounded-md bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Rename
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={isBusy || !selectedRoomId}
            className="rounded-md bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
