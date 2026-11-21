interface TryItOnSwitchProps {
  /** The option's state. On means the primary action renders a look and spends 1 credit. */
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}

/** The accessible name of the switch: one sentence, and the price it turns on. */
export const TRY_IT_ON_NOW_LABEL = 'Try it on now (1 credit)';

/**
 * Issue 313 — the compose step's option, as a switch.
 *
 * It changes what the primary button *is* — `Generate try-on` against a credit, or
 * `Save outfit` with none — and never which rows are ticked in `To try on`. It is a
 * switch rather than a checkbox because every staged row already carries a
 * `Select`/`Deselect` checkbox in the same column; a second checkbox would read as
 * another selection.
 */
export default function TryItOnSwitch({ checked, onChange, disabled = false }: TryItOnSwitchProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={TRY_IT_ON_NOW_LABEL}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="group inline-flex items-center gap-2 rounded-lg px-1 py-1 text-left text-sm font-medium text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          aria-hidden="true"
          className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${
            checked ? 'bg-indigo-600' : 'bg-gray-300'
          }`}
        >
          <span
            aria-hidden="true"
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
              checked ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </span>
        <span>{TRY_IT_ON_NOW_LABEL}</span>
      </button>
    </div>
  );
}
