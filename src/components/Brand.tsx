/** CourtBook mark: an original stylised cedar in red. Used in headers and the sign-in page. */
export function Cedar({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={`text-cedar ${className}`} aria-hidden="true">
      <path d="M12 2 4 11h3l-3 4h4l-2 3h5v4h2v-4h5l-2-3h4l-3-4h3z" />
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
