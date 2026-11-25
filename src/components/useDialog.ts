"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** The width from which the website uses its desktop layout (Phase I, decision D1). */
export const DESKTOP_QUERY = "(min-width: 1024px)";

/**
 * True from 1024 px. False on the server and on the first render, so the page first renders as on a
 * phone and switches after hydration. Use only where the two layouts need different behaviour
 * (e.g. a modal sheet on phones, a side panel on desktop); plain sizing stays in CSS.
 */
export function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(DESKTOP_QUERY);
    const on = () => setDesktop(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return desktop;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard behaviour for the sheets (bottom sheets on phones; dialogs or side panels on desktop).
 * - Esc closes, unless `canClose` is false (while a booking or level is being saved).
 * - Modal sheets (`modal`, the default), at every width: focus moves into the panel when it opens,
 *   Tab and Shift+Tab stay inside it, focus that lands on anything behind the panel is brought back,
 *   and focus returns to where it was when the sheet closes. Give the panel role="dialog",
 *   aria-modal="true" and a label.
 * - Non-modal panels (the club page's booking card, which sits beside the time grid): Esc only.
 * Returns a ref for the panel element.
 */
export function useDialog<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
  { canClose = true, modal = true }: { canClose?: boolean; modal?: boolean } = {},
) {
  const ref = useRef<T>(null);
  // the latest onClose and canClose, for the key handler; updated after each render (not during it)
  const close = useRef(onClose);
  const allowed = useRef(canClose);
  useLayoutEffect(() => { close.current = onClose; allowed.current = canClose; });

  useEffect(() => {
    if (!open) return;
    const panel = ref.current;
    const before = document.activeElement as HTMLElement | null;
    if (modal && panel) {
      if (!panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");
      panel.focus({ preventScroll: true });
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (allowed.current) close.current();
        return;
      }
      if (e.key !== "Tab" || !modal || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) { e.preventDefault(); panel.focus({ preventScroll: true }); return; }
      const first = items[0], last = items[items.length - 1], at = document.activeElement;
      if (!panel.contains(at)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && (at === first || at === panel)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    }
    // anything that moves focus behind the panel (a click on the top bar, a screen-reader jump) is undone
    function onFocusIn(e: FocusEvent) {
      if (!modal || !panel) return;
      const t = e.target as Node | null;
      if (t && !panel.contains(t)) panel.focus({ preventScroll: true });
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
      if (modal && before && typeof before.focus === "function" && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, [open, modal]);

  return ref;
}
