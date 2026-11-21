interface OutfitLookBadgeProps {
  status: string | null | undefined;
}

const BADGE_STYLES: Record<string, { label: string; className: string }> = {
  Pending: { label: 'Pending', className: 'bg-blue-100 text-blue-800' },
  Processing: { label: 'Processing', className: 'bg-yellow-100 text-yellow-800' },
  Failed: { label: 'Failed', className: 'bg-red-100 text-red-800' },
};

/**
 * The live state of an outfit's generation, shared by the Wardrobe card and the
 * Fitting Room's try-on. Complete is expressed by the look image itself,
 * so it renders no badge; Pending, Processing and Failed stay distinguishable.
 */
export default function OutfitLookBadge({ status }: OutfitLookBadgeProps) {
  if (!status) return null;
  const badge = BADGE_STYLES[status];
  if (!badge) return null;

  return (
    <span
      data-testid={`outfit-look-badge-${badge.label.toLowerCase()}`}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}
    >
      {badge.label}
    </span>
  );
}
