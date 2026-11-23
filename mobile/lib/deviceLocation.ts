import { useCallback, useEffect, useState } from "react";
import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import {
  DEFAULT_PREFS, enableNearby, loadPrefs, resumeNearby, savePrefs,
  type KeyValueStore, type LatLng, type LocationProvider, type LocationState, type Permission,
} from "./nearby";

/**
 * The device side of Near me (docs/favourites/README.md §B), behind the foundation's LocationProvider:
 *  - approximate accuracy, foreground only (app.json blocks precise and background location; checked by
 *    scripts/check-native-config.sh);
 *  - one fix when asked; no watching, no background task;
 *  - the position stays in memory (nearby.ts rounds it to ~1 km); only the CHOICE "use my location" is stored.
 */
export const expoLocation: LocationProvider = {
  async permission() {
    const r = await Location.getForegroundPermissionsAsync();
    return { status: r.status as Permission, canAskAgain: r.canAskAgain };
  },
  async request() {
    const r = await Location.requestForegroundPermissionsAsync();
    return { status: r.status as Permission, canAskAgain: r.canAskAgain };
  },
  current(timeoutMs: number): Promise<LatLng> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low })
        .then((p) => { clearTimeout(t); resolve({ lat: p.coords.latitude, lng: p.coords.longitude }); })
        .catch((e) => { clearTimeout(t); reject(e); });
    });
  },
  servicesEnabled: () => Location.hasServicesEnabledAsync(),
};

export const secureKeyValue: KeyValueStore = {
  getItem: (k) => SecureStore.getItemAsync(k),
  setItem: (k, v) => SecureStore.setItemAsync(k, v),
};

/** Near me for one screen. Never asks on its own: only `toggle` (the player's tap) may show the system prompt. */
export function useNearby(provider: LocationProvider = expoLocation, store: KeyValueStore = secureKeyValue) {
  const [state, setState] = useState<LocationState>({ status: "off" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const prefs = await loadPrefs(store);
      const s = await resumeNearby(provider, prefs.useLocation);
      if (alive) setState(s);
    })();
    return () => { alive = false; };
  }, [provider, store]);
  const remember = useCallback((on: boolean) => savePrefs(store, { ...DEFAULT_PREFS, useLocation: on }).catch(() => {}), [store]);
  const toggle = useCallback(async () => {
    if (state.status === "on") { setState({ status: "off" }); await remember(false); return; }
    setBusy(true);
    const s = await enableNearby(provider);
    setBusy(false);
    setState(s);
    await remember(s.status === "on");
  }, [state.status, provider, remember]);
  const turnOff = useCallback(() => { if (state.status !== "off") { setState({ status: "off" }); void remember(false); } }, [state.status, remember]);
  return { state, busy, toggle, turnOff };
}
