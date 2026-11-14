import { View } from "react-native";
import { Tabs } from "expo-router";
import { Icon, type IconName } from "../../components/Icon";
import { color, font } from "../../lib/theme";

/**
 * The four tabs approved in Phase 7. The active tab is marked three ways, not by colour alone:
 * bold label, heavier green icon, and the short red line above it (the one red element of the bar).
 */
function TabIcon({ name, focused }: { name: IconName; focused: boolean }) {
  return (
    <View style={{ alignItems: "center" }}>
      <View style={{ position: "absolute", top: -8, width: 24, height: 3, borderRadius: 2, backgroundColor: focused ? color.red : "transparent" }} />
      <Icon name={name} color={focused ? color.cedar : color.muted} strokeWidth={focused ? 2.1 : 1.8} />
    </View>
  );
}

const tab = (title: string, icon: IconName) => ({
  title,
  tabBarIcon: ({ focused }: { focused: boolean }) => <TabIcon name={icon} focused={focused} />,
});

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: color.ink,
        tabBarInactiveTintColor: color.muted,
        tabBarStyle: { backgroundColor: color.card, borderTopColor: color.line },
        tabBarLabelStyle: { fontSize: 12, fontFamily: font.semibold },
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
