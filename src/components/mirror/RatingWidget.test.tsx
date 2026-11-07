// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import RatingWidget from './RatingWidget';

const STAR_NAMES = ['1 star', '2 stars', '3 stars', '4 stars', '5 stars'];

function star(name: string) {
  return screen.getByRole('radio', { name });
}

function stars() {
  return screen.getAllByRole('radio');
}

describe('RatingWidget', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders one radio group named "Rate this result" with five named stars, one tab stop, and the focus ring', () => {
    render(<RatingWidget rating={null} onChange={() => {}} />);

    expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
    expect(screen.getByRole('radiogroup', { name: 'Rate this result' })).toBeInTheDocument();

    const buttons = stars();
    expect(buttons).toHaveLength(5);
    STAR_NAMES.forEach((name) => expect(star(name)).toBeInTheDocument());
    buttons.forEach((button) => expect(button).toHaveAttribute('aria-checked', 'false'));
    expect(buttons.map((button) => button.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1']);

    const firstStar = star('1 star');
    expect(firstStar).toHaveClass('focus-visible:ring-2');
    expect(firstStar).toHaveClass('focus-visible:ring-indigo-500');
  });

  it('exposes a stored rating as the checked star and the single tab stop', () => {
    render(<RatingWidget rating={3} onChange={() => {}} />);

    expect(star('3 stars')).toHaveAttribute('aria-checked', 'true');
    expect(stars().map((button) => button.getAttribute('tabindex'))).toEqual(['-1', '-1', '0', '-1', '-1']);
    expect(screen.getByText('Your rating: 3/5')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Your rating: 3 out of 5')).toBeInTheDocument();
  });

  it('reports a click, checks and fills the selected stars, and states the selection as not yet stored', () => {
    const onChange = vi.fn();
    render(<RatingWidget rating={null} onChange={onChange} />);

    fireEvent.click(star('4 stars'));

    expect(onChange).toHaveBeenCalledWith(4);
    expect(star('4 stars')).toHaveAttribute('aria-checked', 'true');

    const buttons = stars();
    buttons.slice(0, 4).forEach((button) => expect(button.querySelector('.text-indigo-500')).not.toBeNull());
    expect(buttons[4].querySelector('.text-gray-300')).not.toBeNull();
    expect(screen.getByText('4 of 5 selected')).toBeInTheDocument();
  });

  it('moves the selection and focus with the arrow keys and wraps at both ends', () => {
    const onChange = vi.fn();
    render(<RatingWidget rating={null} onChange={onChange} />);

    star('1 star').focus();
    fireEvent.keyDown(star('1 star'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(2);
    expect(star('2 stars')).toHaveFocus();
    expect(star('2 stars')).toHaveAttribute('aria-checked', 'true');

    fireEvent.keyDown(star('2 stars'), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(1);
    expect(star('1 star')).toHaveFocus();
    expect(star('1 star')).toHaveAttribute('aria-checked', 'true');

    fireEvent.keyDown(star('1 star'), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(5);
    expect(star('5 stars')).toHaveFocus();
    expect(star('5 stars')).toHaveAttribute('aria-checked', 'true');

    fireEvent.keyDown(star('5 stars'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(1);
    expect(star('1 star')).toHaveFocus();
    expect(star('1 star')).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps exactly one tab stop as the selection moves', () => {
    render(<RatingWidget rating={null} onChange={() => {}} />);

    star('1 star').focus();
    fireEvent.keyDown(star('1 star'), { key: 'ArrowDown' });
    fireEvent.keyDown(star('2 stars'), { key: 'ArrowRight' });
    fireEvent.keyDown(star('3 stars'), { key: 'ArrowUp' });

    const tabStops = stars().filter((button) => button.getAttribute('tabindex') === '0');
    expect(tabStops).toHaveLength(1);
    expect(tabStops[0]).toHaveAccessibleName('2 stars');
    expect(tabStops[0]).toHaveAttribute('aria-checked', 'true');
  });

  it('renders a read-only rating as text with no control in the tab order', () => {
    const { container } = render(<RatingWidget rating={4} onChange={() => {}} readonly />);

    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('radiogroup')).toHaveLength(0);
    expect(container.querySelector('input, select, textarea')).toBeNull();

    const paragraph = container.querySelector('p');
    expect(paragraph).not.toBeNull();
    const starContainer = paragraph?.querySelector('[aria-hidden="true"]');
    expect(starContainer).not.toBeNull();
    const starIcons = Array.from(starContainer?.children ?? []);
    expect(starIcons).toHaveLength(5);
    starIcons.slice(0, 4).forEach((icon) => expect(icon).toHaveClass('text-indigo-500'));
    expect(starIcons[4]).toHaveClass('text-gray-300');

    expect(screen.getByText('Your rating: 4/5')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Your rating: 4 out of 5')).toBeInTheDocument();

    const tabbable = container.querySelectorAll('[tabindex]');
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(paragraph);
    expect(tabbable[0]).toHaveAttribute('tabindex', '-1');
  });

  it('states a stored zero rating and states an absent one', () => {
    const { container, rerender } = render(<RatingWidget rating={0} onChange={() => {}} readonly />);

    expect(screen.getByText('Your rating: 0 out of 5')).toBeInTheDocument();
    expect(container.querySelector('.text-indigo-500')).toBeNull();

    rerender(<RatingWidget rating={null} onChange={() => {}} readonly />);

    expect(screen.getByText('Not rated')).toBeInTheDocument();
    expect(screen.queryByText(/Your rating:/)).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it("lets the caller's rating replace a stale echo", () => {
    const { rerender } = render(<RatingWidget rating={null} onChange={() => {}} />);
    fireEvent.click(star('4 stars'));
    expect(screen.getByText('4 of 5 selected')).toBeInTheDocument();

    rerender(<RatingWidget rating={2} onChange={() => {}} />);

    expect(star('2 stars')).toHaveAttribute('aria-checked', 'true');
    const buttons = stars();
    buttons.slice(0, 2).forEach((button) => expect(button.querySelector('.text-indigo-500')).not.toBeNull());
    buttons.slice(2).forEach((button) => expect(button.querySelector('.text-gray-300')).not.toBeNull());
    expect(screen.getByText('Your rating: 2 out of 5')).toBeInTheDocument();
    expect(screen.queryByText('4 of 5 selected')).toBeNull();
  });

  it('clears the pending echo on a reset-token change without moving focus or changing the control contract', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <RatingWidget rating={null} onChange={onChange} echoResetToken={0} />
    );
    star('4 stars').focus();
    fireEvent.click(star('4 stars'));
    expect(star('4 stars')).toHaveFocus();
    expect(screen.getByText('4 of 5 selected')).toBeInTheDocument();

    rerender(<RatingWidget rating={null} onChange={onChange} echoResetToken={1} />);

    expect(screen.queryByText('4 of 5 selected')).toBeNull();
    expect(screen.getByText('Rate this result')).toBeInTheDocument();
    expect(screen.queryByText(/Your rating:/)).toBeNull();
    // The reset is in place: the clicked star keeps focus and the contract holds.
    expect(star('4 stars')).toHaveFocus();
    expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
    expect(screen.getByRole('radiogroup', { name: 'Rate this result' })).toBeInTheDocument();
    stars().forEach((button) => expect(button).toHaveAttribute('aria-checked', 'false'));
    expect(stars().map((button) => button.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1']);
    STAR_NAMES.forEach((name) => expect(star(name)).toBeInTheDocument());
  });

  it('keeps a stored zero rating keyboard-reachable', () => {
    render(<RatingWidget rating={0} onChange={() => {}} />);

    stars().forEach((button) => expect(button).toHaveAttribute('aria-checked', 'false'));
    expect(star('1 star')).toHaveAttribute('tabindex', '0');
    expect(screen.getByText('Your rating: 0/5')).toBeInTheDocument();
  });

  it('previews a hover without changing the selection or the sentence', () => {
    const onChange = vi.fn();
    render(<RatingWidget rating={2} onChange={onChange} />);

    fireEvent.mouseEnter(star('5 stars'));

    stars().forEach((button) => expect(button.querySelector('.text-indigo-500')).not.toBeNull());
    expect(screen.queryAllByRole('radio', { checked: true })).toHaveLength(1);
    expect(star('2 stars')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Your rating: 2/5')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.mouseLeave(star('5 stars'));

    const buttons = stars();
    buttons.slice(0, 2).forEach((button) => expect(button.querySelector('.text-indigo-500')).not.toBeNull());
    buttons.slice(2).forEach((button) => expect(button.querySelector('.text-gray-300')).not.toBeNull());
  });

  it('moves focus to the read-only sentence when a successful save replaces the focused control', () => {
    const { rerender } = render(<RatingWidget rating={null} onChange={() => {}} />);
    star('4 stars').focus();
    expect(star('4 stars')).toHaveFocus();

    rerender(<RatingWidget rating={4} onChange={() => {}} readonly />);

    expect(screen.getByText('Your rating: 4 out of 5').closest('p')).toHaveFocus();
  });

  it('does not move focus when a read-only card appears without focus or another card updates', () => {
    const { rerender } = render(
      <>
        <button type="button">External control</button>
        <RatingWidget rating={null} onChange={() => {}} />
      </>
    );
    const external = screen.getByRole('button', { name: 'External control' });
    external.focus();
    expect(external).toHaveFocus();

    rerender(
      <>
        <button type="button">External control</button>
        <RatingWidget rating={4} onChange={() => {}} readonly />
      </>
    );
    expect(external).toHaveFocus();

    cleanup();

    const twoWidgets = render(
      <>
        <RatingWidget rating={null} onChange={() => {}} />
        <RatingWidget rating={null} onChange={() => {}} />
      </>
    );
    const thirdStars = screen.getAllByRole('radio', { name: '3 stars' });
    expect(thirdStars).toHaveLength(2);
    thirdStars[0].focus();
    expect(thirdStars[0]).toHaveFocus();

    twoWidgets.rerender(
      <>
        <RatingWidget rating={null} onChange={() => {}} />
        <RatingWidget rating={4} onChange={() => {}} readonly />
      </>
    );
    expect(thirdStars[0]).toHaveFocus();
  });

  it('does not let a stale selection reach the read-only branch', () => {
    const { rerender } = render(<RatingWidget rating={null} onChange={() => {}} />);
    fireEvent.click(star('4 stars'));
    expect(screen.getByText('4 of 5 selected')).toBeInTheDocument();

    rerender(<RatingWidget rating={null} onChange={() => {}} readonly />);

    expect(screen.getByText('Not rated')).toBeInTheDocument();
    expect(screen.queryByText('Your rating: 4/5')).toBeNull();
    expect(screen.queryByText('Your rating: 4 out of 5')).toBeNull();
    expect(screen.queryByText('4 of 5 selected')).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
