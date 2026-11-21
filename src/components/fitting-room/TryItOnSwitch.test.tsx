// @vitest-environment jsdom
import { vi, describe, it, expect } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import TryItOnSwitch, { TRY_IT_ON_NOW_LABEL } from './TryItOnSwitch';

afterEach(cleanup);

describe('TryItOnSwitch', () => {
  it('is a switch named Try it on now (1 credit)', () => {
    render(<TryItOnSwitch checked onChange={vi.fn()} />);

    const control = screen.getByRole('switch', { name: TRY_IT_ON_NOW_LABEL });
    expect(control).toHaveAttribute('aria-checked', 'true');
    expect(TRY_IT_ON_NOW_LABEL).toBe('Try it on now (1 credit)');
  });

  it('reports the next state rather than the current one', () => {
    const onChange = vi.fn();
    render(<TryItOnSwitch checked onChange={onChange} />);

    fireEvent.click(screen.getByRole('switch', { name: TRY_IT_ON_NOW_LABEL }));

    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('reports on when it is off', () => {
    const onChange = vi.fn();
    render(<TryItOnSwitch checked={false} onChange={onChange} />);

    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
