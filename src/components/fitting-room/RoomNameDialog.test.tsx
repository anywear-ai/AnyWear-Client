// @vitest-environment jsdom
import { vi, describe, it, expect, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import RoomNameDialog, { DEFAULT_ROOM_NAME, ROOM_NAME_MAX_LENGTH } from './RoomNameDialog';

afterEach(cleanup);

const baseProps = {
  isOpen: true,
  isSubmitting: false,
  onSubmit: vi.fn(),
  onCancel: vi.fn(),
};

describe('RoomNameDialog create', () => {
  it('submits a typed name', () => {
    const onSubmit = vi.fn();
    render(<RoomNameDialog {...baseProps} mode="create" onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: '  Studio  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));

    // The Service stores the trimmed value.
    expect(onSubmit).toHaveBeenCalledWith('  Studio  ');
  });

  it('allows a blank name and says it becomes Fitting Room', () => {
    render(<RoomNameDialog {...baseProps} mode="create" />);

    expect(screen.getByRole('button', { name: 'Create room' })).toBeEnabled();
    expect(screen.getByText(new RegExp(`Leave the name blank to store it as “${DEFAULT_ROOM_NAME}”`))).toBeInTheDocument();
  });

  it('holds a name over the 200-character bound and states the requirement', () => {
    render(<RoomNameDialog {...baseProps} mode="create" />);

    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'x'.repeat(ROOM_NAME_MAX_LENGTH + 1) } });

    expect(screen.getByRole('button', { name: 'Create room' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(`at most ${ROOM_NAME_MAX_LENGTH} characters`);
  });
});

describe('RoomNameDialog rename', () => {
  it('starts from the current name', () => {
    render(<RoomNameDialog {...baseProps} mode="rename" initialName="Studio" />);

    expect(screen.getByLabelText('Room name')).toHaveValue('Studio');
    expect(screen.getByRole('button', { name: 'Save name' })).toBeEnabled();
  });

  it('holds a blank name and states the length requirement', () => {
    render(<RoomNameDialog {...baseProps} mode="rename" initialName="Studio" />);

    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: '   ' } });

    expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(`1 to ${ROOM_NAME_MAX_LENGTH} characters`);
  });

  it('holds a 201-character name', () => {
    render(<RoomNameDialog {...baseProps} mode="rename" initialName="Studio" />);

    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'y'.repeat(ROOM_NAME_MAX_LENGTH + 1) } });

    expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
  });

  it('submits the trimmed name it was given', () => {
    const onSubmit = vi.fn();
    render(<RoomNameDialog {...baseProps} mode="rename" initialName="Studio" onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: ' Evening ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

    expect(onSubmit).toHaveBeenCalledWith(' Evening ');
  });
});

describe('RoomNameDialog shell', () => {
  it('shows the Service sentence a refused save returned', () => {
    render(<RoomNameDialog {...baseProps} mode="rename" initialName="Studio" errorMessage="Room name is taken." />);

    expect(screen.getByRole('alert')).toHaveTextContent('Room name is taken.');
  });

  it('renders nothing when it is closed', () => {
    const { container } = render(<RoomNameDialog {...baseProps} mode="create" isOpen={false} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
