import { useEffect, useState } from "react";
import { onlineManager } from "@tanstack/react-query";

/**
 * Whether the phone is online, as React Query sees it (wired to NetInfo in lib/query.ts).
 * For what the screen shows only; the reservation store checks onlineManager itself at the moment
 * of sending, because the connection can drop between a render and a tap.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(onlineManager.isOnline());
  useEffect(() => {
    setOnline(onlineManager.isOnline()); // in case it changed between the first render and subscribing
    return onlineManager.subscribe(setOnline);
  }, []);
  return online;
}
