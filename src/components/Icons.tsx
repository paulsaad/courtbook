/** Stroke icons (24-box). Colour comes from currentColor. */
type P = { size?: number; className?: string };
const base = (size: number, className: string, children: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">{children}</svg>
);
export const IconHome = ({ size = 24, className = "" }: P) => base(size, className, <path d="M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />);
export const IconCourt = ({ size = 24, className = "" }: P) => base(size, className, <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M12 5v14M3 12h18" /></>);
export const IconCalendar = ({ size = 24, className = "" }: P) => base(size, className, <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>);
export const IconUser = ({ size = 24, className = "" }: P) => base(size, className, <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>);
export const IconUsers = ({ size = 24, className = "" }: P) => base(size, className, <><circle cx="8" cy="9" r="3.5" /><circle cx="16" cy="9" r="3.5" /><path d="M2 20a6 6 0 0 1 12 0M10 20a6 6 0 0 1 12 0" /></>);
export const IconRacket = ({ size = 24, className = "" }: P) => base(size, className, <path d="M4 20 14 10M14 10a4.5 4.5 0 1 0 6-6 4.5 4.5 0 0 0-6 6z" />);
export const IconBell = ({ size = 24, className = "" }: P) => base(size, className, <path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0" />);
export const IconSearch = ({ size = 24, className = "" }: P) => base(size, className, <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>);
export const IconPin = ({ size = 24, className = "" }: P) => base(size, className, <><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" /></>);
export const IconHeart = ({ size = 24, className = "", filled = false }: P & { filled?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.8} className={className} aria-hidden="true"><path d="M12 21s-7-4.5-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.5-9 9-9 9z" /></svg>
);
export const IconChevron = ({ size = 24, className = "" }: P) => base(size, className, <path d="m9 6 6 6-6 6" />);
