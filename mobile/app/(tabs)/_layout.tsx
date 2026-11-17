import { Text, View } from "react-native";
import { Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "../../components/Icon";
import { color, font } from "../../lib/theme";

/**
 * The four tabs approved in Phase 7, refined by the approved Club Info handoff (2026-11-16): 64 pt bar,
 * active label in cedar SemiBold, inactive Medium in muted, and an 18 × 2.5 pt red line on the bar's
 * top edge. The active tab is marked three ways, not by colour alone: heavier label, heavier icon,
 * and the red line (the one red element of the bar).
 */
const BAR_TOP_PADDING = 8;
function TabIcon({ name, focused }: { name: IconName; focused: boolean }) {
  return (
    <View style={{ alignItems: "center" }}>
      <View style={{ position: "absolute", top: -8 - BAR_TOP_PADDING, width: 18, height: 2.5, borderRadius: 2, backgroundColor: focused ? color.red : "transparent" }} />
      <Icon name={name} color={focused ? color.cedar : color.muted} strokeWidth={focused ? 2.1 : 1.8} />
    </View>
  );
}

// Labels follow the phone's text size, but only up to 1.2×: beyond that the tab bar can't grow and
// the words were cut off (Android, text 1.6×). Icons and the red line still mark the active tab.
const tab = (title: string, icon: IconName) => ({
  title,
  tabBarLabel: ({ focused, color: c }: { focused: boolean; color: import("react-native").ColorValue }) => (
    <Text maxFontSizeMultiplier={1.2} numberOfLines={1} style={{ fontSize: 11, lineHeight: 14, fontFamily: focused ? font.semibold : font.medium, color: c }}>{title}</Text>
  ),
  tabBarIcon: ({ focused }: { focused: boolean }) => <TabIcon name={icon} focused={focused} />,
});

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: color.cedar,
        tabBarInactiveTintColor: color.muted,
        tabBarStyle: { backgroundColor: color.card, borderTopColor: color.line, height: 64 + insets.bottom, paddingTop: BAR_TOP_PADDING },
        tabBarLabelStyle: { fontSize: 11, fontFamily: font.medium },
        tabBarAllowFontScaling: true,
        headerStyle: { backgroundColor: color.card },
        headerTitleStyle: { fontFamily: font.display, fontSize: 18 },
        headerTintColor: color.ink,
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: color.ground },
      }}
    >
      <Tabs.Screen name="index" options={{ ...tab("Home", "home"), headerShown: false }} />
      <Tabs.Screen name="courts" options={tab("Courts", "court")} />
      <Tabs.Screen name="bookings" options={tab("Bookings", "calendar")} />
      <Tabs.Screen name="profile" options={tab("Profile", "person")} />
    </Tabs>
  );
}
