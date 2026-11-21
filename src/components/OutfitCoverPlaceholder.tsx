interface OutfitCoverPlaceholderProps {
  /** The caption the cover states under the graphic, e.g. `No look yet`. */
  caption: string;
}

/**
 * Issue 313 — the bundled graphic a saved outfit with no look paints.
 *
 * It is the Client's own resource, not data: it is inlined in the bundle, makes no
 * image request, and needs no API field. A set saved from the Fitting Room's
 * `Save outfit` path has `latestGeneration` and `look` both null, which is exactly
 * the never-generated state; the placeholder is what that state looks like, and it
 * is not an error report about a generation that does not exist.
 *
 * Decorative by contract: the caption carries the meaning, so the drawing is
 * `aria-hidden` and never enters the accessibility tree as an image.
 */
export default function OutfitCoverPlaceholder({ caption }: OutfitCoverPlaceholderProps) {
  return (
    <div
      data-testid="outfit-cover-placeholder"
      className="flex h-full flex-col items-center justify-center gap-1 px-2 text-center text-sm text-gray-400"
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 48 48"
        className="h-10 w-10"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* A hanger with a simple garment: the shape of a look that is not rendered yet. */}
        <path d="M24 15a4 4 0 1 1 4-4" />
        <path d="M24 15 6 27v9h36v-9L24 15Z" />
        <path d="M18 27v9M30 27v9" />
      </svg>
      <span>{caption}</span>
    </div>
  );
}
