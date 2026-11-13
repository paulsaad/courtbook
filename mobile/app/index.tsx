import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Link } from "expo-router";
import { formatInTimeZone } from "date-fns-tz";
import { supabase, configNote, supabaseHost } from "../lib/supabase";
import { useSession } from "../lib/session";
import type { DaySlot } from "../lib/types";

const TZ = "Asia/Beirut";

type Grouped = {
  club_id: string;
  club_name: string;
  town: string | null;
  is_demo: boolean | null;
  timezone: string;
  price_from: number | null;
  slots: DaySlot[];
};

function groupByClub(rows: DaySlot[]): Grouped[] {
  const out: Grouped[] = [];
  for (const row of rows) {
    let club = out.find((c) => c.club_id === row.club_id);
    if (!club) {
      club = {
        club_id: row.club_id,
        club_name: row.club_name,
        town: row.town,
        is_demo: row.is_demo,
        timezone: row.timezone,
        price_from: row.price_from,
        slots: [],
      };
      out.push(club);
    }
    club.slots.push(row);
  }
  return out;
}

export default function Availability() {
  const session = useSession();
  const [rows, setRows] = useState<DaySlot[] | null | undefined>(undefined); // undefined = loading, null = failed
  const [failure, setFailure] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    // Today as the clubs reckon it, not as the phone's clock reckons it.
    const date = formatInTimeZone(new Date(), TZ, "yyyy-MM-dd");
    const { data, error } = await supabase.rpc("club_day_slots", {
      p_date: date,
      p_sport: null,
      p_governorate: null,
      p_district: null,
      p_query: null,
    });
    if (error) {
      // There is no console on a phone, so the reason goes on the screen.
      // Supabase errors carry a code, message, details and hint; none of them
      // is a credential, and the anon key is never touched here. The host is
      // included because a wrong URL is the failure this is most often hiding,
      // and the host alone would have named it the first time.
      setFailure(
        [
          error.code ? `Code ${error.code}` : null,
          error.message,
          error.details,
          error.hint,
          `Host: ${supabaseHost}`,
        ]
          .filter(Boolean)
          .join("\n")
      );
      setRows(null);
      return;
    }
    setFailure(null);
    setRows((data ?? []) as DaySlot[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.authBar}>
        {session.status === "loading" ? (
          <Text style={styles.muted}>Checking sign-in…</Text>
        ) : session.status === "signed-in" ? (
          <>
            <Text style={styles.muted} numberOfLines={1}>
              Signed in as {session.session.user.email ?? "your account"}
            </Text>
            <Pressable onPress={() => void supabase.auth.signOut()} hitSlop={8}>
              <Text style={styles.link}>Sign out</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.muted}>Not signed in</Text>
            <Link href="/sign-in" style={styles.link}>
              Sign in
            </Link>
          </>
        )}
      </View>

      {configNote !== null && (
        <View style={styles.warning}>
          <Text style={styles.detail} selectable>{configNote}</Text>
        </View>
      )}

      <Text style={styles.heading}>Free today</Text>

      {rows === undefined && (
        <View style={styles.centre}>
          <ActivityIndicator />
        </View>
      )}

      {rows === null && (
        <View style={styles.card}>
          <Text style={styles.body}>Could not load availability.</Text>
          {failure !== null && <Text style={styles.detail} selectable>{failure}</Text>}
          <Pressable onPress={onRefresh} hitSlop={8}>
            <Text style={styles.link}>Try again</Text>
          </Pressable>
        </View>
      )}

      {rows !== undefined && rows !== null && rows.length === 0 && (
        <View style={styles.card}>
          <Text style={styles.body}>No free courts left today.</Text>
        </View>
      )}

      {rows !== undefined &&
        rows !== null &&
        groupByClub(rows).map((club) => (
          <View key={club.club_id} style={styles.card}>
            <Text style={styles.clubName}>{club.club_name}</Text>
            <Text style={styles.muted}>
              {club.town ?? "—"}
              {club.price_from !== null ? ` · from $${club.price_from}` : ""}
            </Text>
            {club.is_demo === true && <Text style={styles.demo}>Fictional demo club</Text>}
            <View style={styles.slotRow}>
              {club.slots.slice(0, 12).map((slot) => (
                <View key={`${slot.court_id}-${slot.start_at}`} style={styles.slot}>
                  <Text style={styles.slotTime}>
                    {formatInTimeZone(new Date(slot.start_at), slot.timezone, "HH:mm")}
                  </Text>
                  <Text style={styles.slotCourt} numberOfLines={1}>
                    {slot.court_name}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#ffffff" },
  content: { padding: 16, paddingBottom: 48, gap: 12 },
  authBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  heading: { fontSize: 22, fontWeight: "700", color: "#111111", marginTop: 4 },
  centre: { paddingVertical: 32, alignItems: "center" },
  card: { borderWidth: 1, borderColor: "#e5e5e5", borderRadius: 12, padding: 14, gap: 6 },
  clubName: { fontSize: 17, fontWeight: "600", color: "#111111" },
  body: { fontSize: 15, color: "#111111" },
  muted: { fontSize: 13, color: "#6b6b6b", flexShrink: 1 },
  link: { fontSize: 14, color: "#1d4ed8", fontWeight: "600" },
  detail: { fontSize: 12, color: "#6b6b6b", lineHeight: 17 },
  warning: { borderWidth: 1, borderColor: "#fcd34d", backgroundColor: "#fffbeb", borderRadius: 12, padding: 12 },
  demo: { fontSize: 12, color: "#92400e", backgroundColor: "#fef3c7", alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, overflow: "hidden" },
  slotRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  slot: { borderWidth: 1, borderColor: "#e5e5e5", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, minWidth: 72 },
  slotTime: { fontSize: 15, fontWeight: "600", color: "#111111" },
  slotCourt: { fontSize: 11, color: "#6b6b6b" },
});
