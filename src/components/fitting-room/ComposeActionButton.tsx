interface ComposeActionButtonProps {
  /** The switch decides which action this is; it never changes the selection. */
  tryItOnNow: boolean;
  onClick: () => void;
  disabled: boolean;
  isLoading: boolean;
  /** `null` means the profile read has not produced a balance: never claim zero. */
  credits: number | null;
}

/**
 * Issue 313 — the compose step's one primary button.
 *
 * On, it is `Generate try-on` and spends 1 credit; off, it is `Save outfit` and
 * spends nothing, so a drained balance does not block saving a set. The statement
 * under it says the price of the action that is currently there, so the switch's
 * two outcomes are both legible before anything is sent.
 */
export default function ComposeActionButton({
  tryItOnNow,
  onClick,
  disabled,
  isLoading,
  credits,
}: ComposeActionButtonProps) {
  const isDisabled = disabled
    || isLoading
    || (tryItOnNow && (credits === null || credits === 0));

  const label = isLoading
    ? (tryItOnNow ? 'Generating...' : 'Saving...')
    : !tryItOnNow
      ? 'Save outfit'
      : credits === null
        ? 'Credits Unavailable'
        : credits === 0
          ? 'Out of Credits'
          : 'Generate try-on';

  const priceStatement = tryItOnNow
    ? 'This uses 1 of your daily credits.'
    : 'No credit is charged for saving an outfit.';

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onClick}
        disabled={isDisabled}
        aria-busy={isLoading}
        className={`w-full inline-flex justify-center items-center rounded-lg border border-transparent px-4 py-3 text-sm font-semibold shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-600 ${
          isDisabled
            ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
            : 'text-white bg-indigo-600 hover:bg-indigo-700'
        }`}
      >
        {isLoading ? (
          <>
            <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" aria-hidden="true">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span>{label}</span>
          </>
        ) : label}
      </button>
      <p className="text-center text-xs text-gray-600">{priceStatement}</p>
    </div>
  );
}
