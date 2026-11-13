import { useEffect, useState } from "react";
import { View } from "react-native";
import { Stack, usePathname } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useFonts } from "expo-font";
import { FONTS } from "../lib/fonts";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionProvider } from "../lib/session";
import { makeQueryClient, wireAppLifecycle } from "../lib/query";
import { trackPath } from "../lib/authRecovery";
import { OfflineBanner } from "../components/OfflineBanner";
import { color, font } from "../lib/theme";

wireAppLifecycle();
// Keep the splash screen up until the typefaces are ready, so no screen flashes in system fonts.
void SplashScreen.preventAutoHideAsync().catch(() => {});

/** Remembers where the person is, so an expired session can bring them back here after sign-in. */
function PathTracker() {
  const path = usePathname();
  useEffect(() => trackPath(path), [path]);
  return null;
}

export default function RootLayout() {
  const [queryClient] = useState(makeQueryClient);
  const [fontsLoaded, fontError] = useFonts(FONTS);
  const ready = fontsLoaded || fontError !== null;
  useEffect(() => {
    // A font that fails to load is not a reason to keep the app closed: it falls back to the
    // system font and carries on.
    if (ready) void SplashScreen.hideAsync().catch(() => {});
  }, [ready]);
  if (!ready) return null;
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <StatusBar style="dark" />
          <PathTracker />
          <View style={{ flex: 1, backgroundColor: color.ground }}>
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: color.card },
                headerTintColor: color.ink,
                headerTitleStyle: { fontFamily: font.display, fontSize: 18 },
                headerShadowVisible: false,
                contentStyle: { backgroundColor: color.ground },
              }}
            >
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="sign-in" options={{ title: "Sign in", presentation: "modal" }} />
              <Stack.Screen name="booking/[id]" options={{ title: "Booking" }} />
              <Stack.Screen name="design-preview" options={{ title: "Component preview" }} />
            </Stack>
            <OfflineBanner />
          </View>
        </SessionProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
