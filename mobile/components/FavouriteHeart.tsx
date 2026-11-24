import { useState } from "react";
import { Alert, Pressable, StyleSheet } from "react-native";
import { router } from "expo-router";
import { Icon } from "./Icon";
import { favouritesShown, heartView, useFavourites, useFavouriteToggle } from "../lib/favourites";
import { color } from "../lib/theme";

/**
 * The heart on a club (0087): filled red when it is a favourite; 48 pt touch area. Drawn only once the list has loaded
 * from a server that has favourites (never a heart that lies). Signed out: leads to sign-in.
 */
export function FavouriteHeart({ clubId, clubName, userId }: { clubId: string; clubName: string; userId: string | null }) {
  const fav = useFavourites(userId);
  const toggle = useFavouriteToggle(userId);
  const [busy, setBusy] = useState(false);
  const available = userId ? favouritesShown(fav) : true;
  const favourite = !!fav.data?.includes(clubId);
  const v = heartView({ signedIn: !!userId, available, favourite, clubName });
  if (!v.visible) return null;
  return (
    <Pressable
      accessibilityRole="button" accessibilityLabel={v.label} accessibilityState={{ selected: v.pressed, busy }} hitSlop={4}
      onPress={async () => {
        if (v.action === "sign-in") { router.push("/sign-in"); return; }
        setBusy(true);
        const r = await toggle(clubId, !favourite);
        setBusy(false);
        if (!r.ok && "failure" in r) Alert.alert("Favourite not saved", r.failure.message);
      }}
      style={styles.heart} testID={`heart-${clubId}`}>
      <Icon name={v.pressed ? "heartFilled" : "heart"} size={24} color={v.pressed ? color.cedar : color.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({ heart: { width: 48, height: 48, alignItems: "center", justifyContent: "center" } });
