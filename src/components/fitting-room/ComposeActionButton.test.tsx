// @vitest-environment jsdom
import { vi, describe, it, expect, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ComposeActionButton from './ComposeActionButton';

afterEach(cleanup);

const baseProps = {
  onClick: vi.fn(),
  disabled: false,
  isLoading: false,
  credits: 5,
};

describe('ComposeActionButton', () => {
  it('is Generate try-on and states the credit when the switch is on', () => {
    render(<ComposeActionButton {...baseProps} tryItOnNow />);

    expect(screen.getByRole('button', { name: 'Generate try-on' })).toBeEnabled();
    expect(screen.getByText('This uses 1 of your daily credits.')).toBeInTheDocument();
  });

  it('is Save outfit and states that no credit is charged when the switch is off', () => {
    render(<ComposeActionButton {...baseProps} tryItOnNow={false} credits={null} />);

    // A drained or unknown balance does not block the free path.
    expect(screen.getByRole('button', { name: 'Save outfit' })).toBeEnabled();
    expect(screen.getByText('No credit is charged for saving an outfit.')).toBeInTheDocument();
  });

  it('keeps the disabled state the page passes', () => {
    render(<ComposeActionButton {...baseProps} tryItOnNow disabled />);
    expect(screen.getByRole('button', { name: 'Generate try-on' })).toBeDisabled();

    cleanup();
    render(<ComposeActionButton {...baseProps} tryItOnNow={false} disabled />);
    expect(screen.getByRole('button', { name: 'Save outfit' })).toBeDisabled();
  });

  it('states the unknown balance and zero balance instead of a label that implies a charge', () => {
    render(<ComposeActionButton {...baseProps} tryItOnNow credits={null} />);
    expect(screen.getByRole('button', { name: 'Credits Unavailable' })).toBeDisabled();

    cleanup();
    render(<ComposeActionButton {...baseProps} tryItOnNow credits={0} />);
    expect(screen.getByRole('button', { name: 'Out of Credits' })).toBeDisabled();
  });

  it('names the busy state of the action that is actually running', () => {
    render(<ComposeActionButton {...baseProps} tryItOnNow isLoading />);
    expect(screen.getByRole('button')).toHaveTextContent('Generating...');

    cleanup();
    render(<ComposeActionButton {...baseProps} tryItOnNow={false} isLoading />);
    expect(screen.getByRole('button')).toHaveTextContent('Saving...');
  });

  it('runs the action it is bound to', () => {
    const onClick = vi.fn();
    render(<ComposeActionButton {...baseProps} tryItOnNow={false} onClick={onClick} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save outfit' }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
