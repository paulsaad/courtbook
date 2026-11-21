"use client";
import { useEffect, useRef } from "react";

/** The width from which the website uses its desktop layout (Phase I, decision D1). */
export const DESKTOP_QUERY = "(min-width: 1024px)";

/**
 * Keyboard behaviour for the sheets, which open as a dialog or side panel on desktop (Phase I-1).
 * - Esc closes (unless `canClose` is false, e.g. while a booking is being saved).
 * - On desktop only, for a modal panel (`modal`, the default): focus moves into the panel when it opens,
 *   Tab stays inside it, and focus returns to where it was when it closes. A non-modal panel (the club
 *   page's booking card, which sits beside the time grid) only gets Esc. On phones focus is unchanged.
 * Returns a ref for the panel element.
 */
export function useDialog<T extends HTMLElement>(open: boolean, onClose: () => void, { canClose = true, modal = true }: { canClose?: boolean; modal?: boolean } = {}) {
  const ref = useRef<T>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const allowed = useRef(canClose);
  allowed.current = canClose;

  useEffect(() => {
    if (!open) return;
    const desktop = modal && typeof window.matchMedia === "function" && window.matchMedia(DESKTOP_QUERY).matches;
    const before = document.activeElement as HTMLElement | null;
    const panel = ref.current;
    if (desktop && panel) {
      if (!panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");
      panel.focus({ preventScroll: true });
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (allowed.current) close.current();
        return;
      }
      if (e.key !== "Tab" || !desktop || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (desktop && before && typeof before.focus === "function") before.focus({ preventScroll: true });
    };
  }, [open]);

  return ref;
}
