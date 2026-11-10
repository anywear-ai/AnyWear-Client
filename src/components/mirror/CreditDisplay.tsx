import { useGetUsersMe } from '../../api/endpoints/users/users';
import useDailyCreditRefresh from '../../hooks/useDailyCreditRefresh';

export default function CreditDisplay() {
  const { data: user } = useGetUsersMe();
  useDailyCreditRefresh();

  const credits = user?.dailyCredits;

  // No profile means the balance is unknown, not zero: `0/10` would claim the
  // user has spent every credit.
  if (credits === undefined || credits === null) {
    return (
      <div
        role="status"
        aria-label="Daily credits unavailable"
        className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-600"
        title="Credits reset daily at midnight"
      >
        <svg
          className="w-4 h-4 mr-1.5 text-gray-400"
          fill="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.41 16.09V20h-2.67v-1.93c-1.71-.36-3.16-1.46-3.27-3.4h1.96c.1 1.05.82 1.87 2.65 1.87 1.96 0 2.4-.98 2.4-1.59 0-.83-.44-1.61-2.67-2.14-2.48-.6-4.18-1.62-4.18-3.67 0-1.72 1.39-2.84 3.11-3.21V4h2.67v1.95c1.86.45 2.79 1.86 2.85 3.39H14.3c-.05-1.11-.64-1.87-2.22-1.87-1.5 0-2.4.68-2.4 1.64 0 .84.65 1.39 2.67 1.91s4.18 1.39 4.18 3.91c-.01 1.83-1.38 2.83-3.12 3.16z" />
        </svg>
        Credits unavailable
      </div>
    );
  }

  const isWarning = credits > 0 && credits <= 2;
  const isError = credits === 0;

  return (
    <div
      role="status"
      aria-label={`${credits} of 10 daily credits remaining`}
      className={`inline-flex items-center rounded-full px-3 py-1.5 text-sm font-medium ${
        isError
          ? 'bg-red-100 text-red-800'
          : isWarning
            ? 'bg-amber-100 text-amber-800'
            : 'bg-green-100 text-green-800'
      }`}
      title="Credits reset daily at midnight"
    >
      <svg
        className={`w-4 h-4 mr-1.5 ${
          isError ? 'text-red-500' : isWarning ? 'text-amber-500' : 'text-green-500'
        }`}
        fill="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.41 16.09V20h-2.67v-1.93c-1.71-.36-3.16-1.46-3.27-3.4h1.96c.1 1.05.82 1.87 2.65 1.87 1.96 0 2.4-.98 2.4-1.59 0-.83-.44-1.61-2.67-2.14-2.48-.6-4.18-1.62-4.18-3.67 0-1.72 1.39-2.84 3.11-3.21V4h2.67v1.95c1.86.45 2.79 1.86 2.85 3.39H14.3c-.05-1.11-.64-1.87-2.22-1.87-1.5 0-2.4.68-2.4 1.64 0 .84.65 1.39 2.67 1.91s4.18 1.39 4.18 3.91c-.01 1.83-1.38 2.83-3.12 3.16z" />
      </svg>
      {credits}/10 today
    </div>
  );
}
