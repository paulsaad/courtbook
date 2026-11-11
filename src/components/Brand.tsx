/**
 * CourtBook mark: an original Lebanese-cedar silhouette — broad, flat, layered tiers on a short trunk — in cedar green.
 * (Not the flag's artwork; drawn from the tree's shape.)
 */
export function Cedar({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
<svg width={size} height={size * 0.83} viewBox="0 0 48 40" fill="currentColor" className={`text-turf ${className}`} aria-hidden="true">
      <path d="M21.6 21.0 L26.4 21.0 L27.8 40.0 L20.2 40.0z" />
      <rect x="12.0" y="2.2" width="24.0" height="4.0" rx="1.6" />
      <rect x="1.0" y="7.8" width="46.0" height="5.2" rx="1.6" />
      <rect x="5.0" y="14.6" width="38.0" height="4.8" rx="1.6" />
      <rect x="11.0" y="20.9" width="26.0" height="4.2" rx="1.6" />
    </svg>
  );
}

export function Wordmark({ size = 24 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2 font-extrabold tracking-tight text-ink" style={{ fontSize: size }}>
      <Cedar size={size} />CourtBook
    </span>
  );
}
