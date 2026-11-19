import { Redirect, useLocalSearchParams } from "expo-router";

/** courtbook://match/<id> (the deep link reserved in the native app plan) opens the Game screen. */
export default function MatchLink() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Redirect href={{ pathname: "/game/[id]", params: { id } }} />;
}
