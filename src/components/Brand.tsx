/**
 * CourtBook mark: an original Lebanese-cedar silhouette — broad, flat, layered tiers on a short trunk — in cedar green.
 * (Not the flag's artwork; drawn from the tree's shape.)
 */
export function Cedar({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size * 0.8} viewBox="0 0 40 32" fill="currentColor" className={`text-turf ${className}`} aria-hidden="true">
      {/* trunk */}
      <rect x="18.6" y="23" width="2.8" height="9" rx="0.8" />
      {/* four flat layers, the cedar's signature silhouette */}
      <path d="M17.5 2.0h5.0l4.5 5.0H13.0z" />
      <path d="M14.0 7.8h12.0l5.5 4.8H8.5z" />
      <path d="M10.0 13.4h20.0l5.5 4.8H4.5z" />
      <path d="M6.0 19.0h28.0l5.0 4.6H1.0z" />
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
