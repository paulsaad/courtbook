import { Tabs } from "expo-router";
import { color } from "../../lib/theme";

/**
 * The four tabs approved in Phase 7. Icons and the tab bar's final look wait for the screen
 * designs to be approved; the structure, order and names are settled.
 */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: color.ink,
        tabBarInactiveTintColor: color.muted,
        tabBarStyle: { backgroundColor: color.card, borderTopColor: color.line },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
        headerStyle: { backgroundColor: color.card },
        headerTintColor: color.ink,
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: color.ground },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Home" }} />
      <Tabs.Screen name="courts" options={{ title: "Courts" }} />
      <Tabs.Screen name="bookings" options={{ title: "Bookings" }} />
      <Tabs.Screen name="profile" options={{ title: "Profile" }} />
    </Tabs>
  );
}
