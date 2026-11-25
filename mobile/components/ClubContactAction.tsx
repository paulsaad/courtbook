import { Linking } from "react-native";
import { router } from "expo-router";
import { Button } from "./Button";
import { useClubPhone } from "../lib/clubPhone";

/**
 * PR-9b: when the cancellation notice asks the player to tell the club, a way to do it. "Call club" when the club has a
 * callable public contact phone; otherwise (none, not a dialable number, or it could not be read) a link to the club's
 * Info tab, which has whatever contact the club published. Nothing is shown while the number is being read. If the
 * phone cannot start the call, the Info tab opens instead.
 */
export function ClubContactAction({ clubId, clubName }: { clubId: string; clubName: string }) {
  const phone = useClubPhone(clubId);
  if (phone.isPending) return null;
  const openInfo = () => router.push({ pathname: "/club/[id]", params: { id: clubId, name: clubName, tab: "info" } });
  if (phone.isSuccess && phone.data) {
    const number = phone.data;
    // A device that cannot place calls (a tablet, no dialler) rejects tel: — then open the Info tab, where the number is shown.
    return <Button label="Call club" variant="secondary" testID="call-club" onPress={() => { Linking.openURL(`tel:${number}`).catch(openInfo); }} />;
  }
  return <Button label="Club info" variant="secondary" testID="club-info-link" onPress={openInfo} />;
}
