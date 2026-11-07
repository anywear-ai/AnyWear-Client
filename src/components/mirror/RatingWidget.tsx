import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

interface RatingWidgetProps {
  rating: number | null;
  onChange: (rating: number) => void;
  readonly?: boolean;
  /**
   * A number that changes when a save for this control settles. The widget then
   * drops its local echo, so a failed save stops showing the rejected value as
   * the selection; it is cleared this way rather than by a remount, which would
   * destroy the focused star.
   */
  echoResetToken?: number;
}

const STARS = [1, 2, 3, 4, 5] as const;

const STAR_LABELS: Record<(typeof STARS)[number], string> = {
  1: '1 star',
  2: '2 stars',
  3: '3 stars',
  4: '4 stars',
  5: '5 stars',
};

const FILLED_STAR = (
  <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6">
    <path fillRule="evenodd" d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.006 5.404.434c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.434 2.082-5.005Z" clipRule="evenodd" />
  </svg>
);

const OUTLINE_STAR = (
  <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-6 h-6">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.006 5.404.434c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.434 2.082-5.005Z" />
  </svg>
);

function StarIcon({ filled }: { filled: boolean }) {
  return <span className={filled ? 'text-indigo-500' : 'text-gray-300'}>{filled ? FILLED_STAR : OUTLINE_STAR}</span>;
}

export default function RatingWidget({ rating, onChange, readonly, echoResetToken }: RatingWidgetProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [echo, setEcho] = useState<{ base: number | null; value: number } | null>(null);
  const hadFocusRef = useRef(false);
  const readOnlyRef = useRef<HTMLParagraphElement>(null);
  const starRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const echoResetTokenRef = useRef(echoResetToken);

  const echoShowing = echo !== null && echo.base === rating;
  const current = echoShowing ? echo.value : rating;
  const tabStop = current !== null && current >= 1 && current <= 5 ? current : 1;
  const displayValue = hoverIndex ?? current ?? 0;

  // A settlement token change clears the echo in place. The star buttons keep
  // their DOM nodes, so focus stays where it is and the roving tab stop returns
  // to the stored value on the next render.
  useLayoutEffect(() => {
    if (echoResetTokenRef.current === echoResetToken) return;
    echoResetTokenRef.current = echoResetToken;
    setEcho(null);
  }, [echoResetToken]);

  useLayoutEffect(() => {
    if (!readonly || !hadFocusRef.current) return;
    hadFocusRef.current = false;
    readOnlyRef.current?.focus();
  }, [readonly, rating]);

  const select = (star: number) => {
    setEcho({ base: rating, value: star });
    onChange(star);
  };

  const handleGroupKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const origin = current !== null && current >= 1 && current <= 5 ? current : 1;
    const next = ((origin - 1 + step + STARS.length) % STARS.length) + 1;
    select(next);
    starRefs.current[next]?.focus();
  };

  if (readonly) {
    return (
      <p ref={readOnlyRef} tabIndex={-1} className="flex items-center gap-1">
        <span aria-hidden="true" className="flex items-center gap-1">
          {STARS.map((star) => (
            <StarIcon key={star} filled={star <= (rating ?? 0)} />
          ))}
        </span>
        <span className="ml-2 text-sm text-gray-600">
          {rating === null ? (
            'Not rated'
          ) : (
            <>
              <span aria-hidden="true">{`Your rating: ${rating}/5`}</span>
              <span className="sr-only">{`Your rating: ${rating} out of 5`}</span>
            </>
          )}
        </span>
      </p>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <div
        role="radiogroup"
        aria-label="Rate this result"
        className="flex items-center gap-1"
        onFocus={() => {
          hadFocusRef.current = true;
        }}
        onBlur={() => {
          hadFocusRef.current = false;
        }}
        onKeyDown={handleGroupKeyDown}
      >
        {STARS.map((star) => (
          <button
            key={star}
            ref={(node) => {
              starRefs.current[star] = node;
            }}
            type="button"
            role="radio"
            aria-checked={current === star}
            aria-label={STAR_LABELS[star]}
            tabIndex={star === tabStop ? 0 : -1}
            className="cursor-pointer transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            onClick={() => select(star)}
            onMouseEnter={() => setHoverIndex(star)}
            onMouseLeave={() => setHoverIndex(null)}
          >
            <StarIcon filled={star <= displayValue} />
          </button>
        ))}
      </div>
      <span className="ml-2 text-sm text-gray-600">
        {current === null ? (
          'Rate this result'
        ) : echoShowing ? (
          `${current} of 5 selected`
        ) : (
          <>
            <span aria-hidden="true">{`Your rating: ${current}/5`}</span>
            <span className="sr-only">{`Your rating: ${current} out of 5`}</span>
          </>
        )}
      </span>
    </div>
  );
}
