/**
 * M5: the public legal pages (/privacy, /terms) and the deletion page share these.
 *
 * LEGAL_STATUS stays "draft" until the operator, address and jurisdiction are decided and a lawyer has approved the
 * wording (master checklist L1, L6; M1). While it is "draft" the pages say so at the top, show every unfinished
 * sentence as a marked item, and ask search engines not to index them. legal.test.tsx refuses "final" while any
 * marked item is left.
 */
export const LEGAL_STATUS: "draft" | "final" = "draft";
export const CONTACT_EMAIL = "courtbook.contact@gmail.com";
/** The date shown as "Last updated" once final; null while draft. */
export const LEGAL_UPDATED: string | null = null;

export const LEGAL_LINKS = [
  { href: "/privacy", label: "Privacy policy" },
  { href: "/terms", label: "Terms of use" },
  { href: "/delete-account", label: "Delete your account" },
] as const;
