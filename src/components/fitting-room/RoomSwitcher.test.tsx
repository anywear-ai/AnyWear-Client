// @vitest-environment jsdom
import { vi, describe, it, expect, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import RoomSwitcher from './RoomSwitcher';
import type { GetFittingRooms200FittingRoomsItem } from '../../api/model/getFittingRooms200FittingRoomsItem';

afterEach(cleanup);

function room(overrides: Partial<GetFittingRooms200FittingRoomsItem> = {}): GetFittingRooms200FittingRoomsItem {
  return {
    id: 'room-1',
    userId: 'user-1',
    name: 'Fitting Room',
    isDefault: true,
    itemCount: 2,
    createdAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

const handlers = {
  onSelect: vi.fn(),
  onCreate: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
};

describe('RoomSwitcher', () => {
  it('lists the rooms in the order the Service returned, with their item counts', () => {
    render(
      <RoomSwitcher
        rooms={[room(), room({ id: 'room-2', name: 'Studio', isDefault: false, itemCount: 0 })]}
        selectedRoomId="room-1"
        {...handlers}
      />,
    );

    const switcher = screen.getByRole('group', { name: 'Fitting rooms' });
    expect(switcher).toHaveTextContent('Fitting Room');
    expect(switcher).toHaveTextContent('Studio');
    expect(screen.getByRole('button', { name: /Fitting Room/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Studio/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('switching only reports the room id', () => {
    render(
      <RoomSwitcher
        rooms={[room(), room({ id: 'room-2', name: 'Studio', isDefault: false })]}
        selectedRoomId="room-1"
        {...handlers}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Studio/ }));

    expect(handlers.onSelect).toHaveBeenCalledWith('room-2');
  });

  it('offers New room, Rename and Delete beside the list', () => {
    render(<RoomSwitcher rooms={[room()]} selectedRoomId="room-1" {...handlers} />);

    fireEvent.click(screen.getByRole('button', { name: 'New room' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(handlers.onCreate).toHaveBeenCalledTimes(1);
    expect(handlers.onRename).toHaveBeenCalledTimes(1);
    expect(handlers.onDelete).toHaveBeenCalledTimes(1);
  });

  it('cannot rename or delete when no room is open', () => {
    render(<RoomSwitcher rooms={[]} selectedRoomId={null} {...handlers} />);

    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    expect(screen.getByText(/The next read creates a default one/)).toBeInTheDocument();
  });
});
