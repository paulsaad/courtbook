import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Wordmark } from "./Brand";

type Item = { href: string; label: string; key: string };
type Props =
  | { area: "staff"; slug: string; clubName: string; active: "calendar" | "payments" | "settings" }
  | { area: "admin"; active: "clubs" | "payments" | "reports" | "deletions" };

/**
 * Admin pages show the open-reports count on Reports, read with the same admin-only call the admin
 * home page already makes (admin_reports, 0074). If it fails or is missing, no count is shown.
 */
export default async function WorkNav(props: Props) {
  let openReports: number | null = null;
  if (props.area === "admin") {
    const supabase = await createClient();
    const { data: open } = await supabase.rpc("admin_reports", { p_status: "open" });
    openReports = Array.isArray(open) ? open.length : null;
  }
  return <WorkNavBar {...props} openReports={openReports} />;
}

/**
 * Desktop-only (≥ 1024 px) top bar for the staff and admin areas, which have no player tab bar.
 * Below 1024 px it renders nothing visible, so phones and tablets are unchanged. Every item is a
 * plain link to a page that already exists; the right side always leads back to the player side.
 */
export function WorkNavBar(props: Props & { openReports?: number | null }) {
  const items: Item[] = props.area === "staff"
    ? [
        { key: "calendar", label: "Calendar", href: `/staff/${props.slug}` },
        { key: "payments", label: "Payments", href: `/staff/${props.slug}/payments` },
        { key: "settings", label: "Settings", href: `/staff/${props.slug}/settings` },
      ]
    : [
        { key: "clubs", label: "Clubs", href: "/admin" },
        { key: "payments", label: "Payments", href: "/admin/payments" },
        { key: "reports", label: props.openReports ? `Reports (${props.openReports} open)` : "Reports", href: "/admin/reports" },
        { key: "deletions", label: "Deletions", href: "/admin/deletions" },
      ];
  const title = props.area === "staff" ? props.clubName : "Admin";
  return (
    <header className="fixed inset-x-0 top-0 z-20 hidden h-16 border-b border-grid bg-white/95 backdrop-blur lg:block">
      <nav aria-label={props.area === "staff" ? "Club staff" : "Admin"} className="mx-auto flex h-16 max-w-[1600px] items-center gap-1 px-6">
        <Link href="/" aria-label="CourtBook home" className="mr-4 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-turf"><Wordmark size={20} /></Link>
        <span className="mr-4 max-w-[320px] truncate border-l border-grid pl-4 text-[15px] font-semibold text-ink" title={title}>{title}</span>
        {items.map((i) => {
          const on = i.key === props.active;
          return (
            <Link key={i.key} href={i.href} aria-current={on ? "page" : undefined}
              className={`relative flex h-16 items-center px-3 text-[15px] focus-visible:outline-2 focus-visible:-outline-offset-8 focus-visible:outline-turf ${on ? "font-bold text-ink" : "font-medium text-[#5f6663] hover:text-ink"}`}>
              {i.label}
              {on && <span className="absolute inset-x-3 bottom-0 h-[3px] rounded-full bg-cedar" />}
            </Link>
          );
        })}
        <div className="ml-auto flex items-center gap-4 text-[15px]">
          {props.area === "staff" ? null : <Link href="/staff" className="font-medium text-[#5f6663] hover:text-ink">Staff calendar</Link>}
          <Link href="/me" className="font-medium text-[#5f6663] hover:text-ink">My bookings</Link>
          <Link href="/profile" className="font-medium text-[#5f6663] hover:text-ink">Profile</Link>
        </div>
      </nav>
    </header>
  );
}
