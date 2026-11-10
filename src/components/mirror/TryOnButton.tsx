interface TryOnButtonProps {
  onGenerate: () => void;
  disabled: boolean;
  isLoading: boolean;
  /**
   * `null` means the profile read has not produced a balance: the button states
   * that the balance is unavailable and disables, rather than claiming zero.
   */
  credits: number | null;
}

export default function TryOnButton({ onGenerate, disabled, isLoading, credits }: TryOnButtonProps) {
  const isDisabled = disabled || isLoading || credits === null || credits === 0;

  return (
    <button
      onClick={onGenerate}
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
          <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span>Generating...</span>
        </>
      ) : credits === null ? (
        'Credits Unavailable'
      ) : credits === 0 ? (
        'Out of Credits'
      ) : (
        'Generate try-on'
      )}
    </button>
  );
}
