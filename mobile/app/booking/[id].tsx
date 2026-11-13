import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Link, useLocalSearchParams } from "expo-router";
import { formatInTimeZone } from "date-fns-tz";
import { supabase } from "../../lib/supabase";
import { useSession } from "../../lib/session";

type AgendaRow = {
  kind: "booking" | "match";
  id: string;
  start_at: string;
  end_at: string | null;
  club_name: string;
  club_slug: string;
  timezone: string;
  title: string | null;
  status: string;
  role: string | null;
};

type Result = { state: "loading" } | { state: "failed" } | { state: "missing" } | { state: "found"; row: AgendaRow };

/**
 * Deep-link target: courtbook://booking/<id>
 *
 * A notification tapped from the lock screen lands here, often before the
 * session has been read back out of storage, so the screen waits for sign-in
 * to resolve rather than deciding the booking does not exist.
 */
export default function Booking() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = useSession();
  const [result, setResult] = useState<Result>({ state: "loading" });

  useEffect(() => {
    if (session.status === "loading") return;
    if (session.status === "signed-out") {
      setResult({ state: "missing" });
      return;
    }
    let alive = true;
    (async () => {
      const { data, error } = await supabase.rpc("my_agenda");
      if (!alive) return;
      if (error) {
        setResult({ state: "failed" });
        return;
      }
      const row = ((data ?? []) as AgendaRow[]).find((r) => r.kind === "booking" && r.id === id);
      setResult(row ? { state: "found", row } : { state: "missing" });
    })();
    return () => {
      alive = false;
    };
  }, [id, session.status]);

  if (session.status === "signed-out") {
    return (
      <View style={styles.page}>
        <Text style={styles.body}>Sign in to see this booking.</Text>
        <Link href="/sign-in" style={styles.link}>
          Sign in
        </Link>
      </View>
    );
  }

  if (result.state === "loading") {
    return (
      <View style={styles.page}>
        <ActivityIndicator />
      </View>
    );
  }

  if (result.state === "failed") {
    return (
      <View style={styles.page}>
        <Text style={styles.body}>Could not load this booking.</Text>
      </View>
    );
  }

  if (result.state === "missing") {
    return (
      <View style={styles.page}>
        <Text style={styles.body}>That booking is not on your agenda.</Text>
        <Link href="/" style={styles.link}>
          Back to availability
        </Link>
      </View>
    );
  }

  const { row } = result;
  return (
    <View style={styles.page}>
      <Text style={styles.heading}>{row.club_name}</Text>
      <Text style={styles.body}>{row.title ?? "Court booking"}</Text>
      <Text style={styles.body}>
        {formatInTimeZone(new Date(row.start_at), row.timezone, "EEEE d MMMM, HH:mm")}
        {row.end_at ? `–${formatInTimeZone(new Date(row.end_at), row.timezone, "HH:mm")}` : ""}
      </Text>
      <Text style={styles.muted}>{row.status}</Text>
      <Link href="/" style={styles.link}>
        Back to availability
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#ffffff", padding: 20, gap: 10 },
  heading: { fontSize: 22, fontWeight: "700", color: "#111111" },
  body: { fontSize: 16, color: "#111111" },
  muted: { fontSize: 13, color: "#6b6b6b" },
  link: { fontSize: 15, color: "#1d4ed8", fontWeight: "600", marginTop: 8 },
});
