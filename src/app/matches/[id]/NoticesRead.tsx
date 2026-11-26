"use client";

import { useEffect } from "react";
import { NOTICES_READ_EVENT } from "@/lib/noticeRead";

/** Tells the tab bar to re-read the unread count after this game page marked notices read (H11/H18): also on a
 *  #91 refresh of the same page, where the path does not change. Renders nothing; no polling. */
export default function NoticesRead({ marked }: { marked: string }) {
  useEffect(() => { if (marked) window.dispatchEvent(new Event(NOTICES_READ_EVENT)); }, [marked]);
  return null;
}
