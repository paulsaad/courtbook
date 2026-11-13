import { useEffect, useState } from "react";
import { View } from "react-native";
import { Stack, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionProvider } from "../lib/session";
import { makeQueryClient, wireAppLifecycle } from "../lib/query";
import { trackPath } from "../lib/authRecovery";
import { OfflineBanner } from "../components/OfflineBanner";
import { color } from "../lib/theme";

wireAppLifecycle();

/** Remembers where the person is, so an expired session can bring them back here after sign-in. */
function PathTracker() {
  const path = usePathname();
  useEffect(() => trackPath(path), [path]);
  return null;
}

export default function RootLayout() {
  const [queryClient] = useState(makeQueryClient);
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
                headerShadowVisible: false,
                contentStyle: { backgroundColor: color.ground },
              }}
            >
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="sign-in" options={{ title: "Sign in", presentation: "modal" }} />
              <Stack.Screen name="booking/[id]" options={{ title: "Booking" }} />
            </Stack>
            <OfflineBanner />
          </View>
        </SessionProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
