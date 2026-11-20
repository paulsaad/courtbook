import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { hhmm } from "@shared/time";
import { Text } from "../../components/Text";
import { KeyboardAware } from "../../components/KeyboardAware";
import { Icon } from "../../components/Icon";
import { Button } from "../../components/Button";
import { Empty, ErrorState, Loading } from "../../components/StateView";
import { SignInPrompt } from "../../components/SignInPrompt";
import { useSession } from "../../lib/session";
import { useOnline } from "../../lib/online";
import { useGame } from "../../lib/games";
import { gameWhen } from "../../lib/gameFormat";
import { sportName } from "../../lib/days";
import { useActivity, useMarkRead } from "../../lib/activity";
import { useGameActions } from "../../lib/gameActions";
import {
  CHAT_AVAILABLE, chatKey, chatRows, COUNTER_FROM, composerState, MESSAGE_MAX, useChat, useChatActions, type ChatData, type ChatMessage, type ChatRow,
} from "../../lib/chat";
import { blockPlayer, reportContent, SAFETY_AVAILABLE, useAcceptRules, useRulesAccepted } from "../../lib/safety";
import { ReportSheet, RulesSheet } from "../../components/game/SafetySheets";
import { useQueryClient } from "@tanstack/react-query";
import { color, font, MAX_FONT_SCALE, radius, space, TOUCH } from "../../lib/theme";

/**
 * Game chat (docs/m3/04-ux-spec.md §4.5, J8). For the organiser and accepted players; everything it
 * may show or send is decided by the database (lib/chat.ts). Opens at the newest message; new
 * messages while reading older ones show a "New messages" pill instead of moving the list.
 */
export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = useSession();
  const signedIn = session.status === "signed-in";
  const me = signedIn ? session.session.user.id : null;
  const online = useOnline();
  const insets = useSafeAreaInsets();
  const game = useGame(id, { signedIn });
  const d = game.data;
  const member = !!d && (d.i_organize || d.my_status === "accepted");
  const chat = useChat(id ?? "", CHAT_AVAILABLE && signedIn && member);
  const actions = useChatActions(id ?? "", me, null);
  const gameActions = useGameActions(id ?? "", { available: CHAT_AVAILABLE });
  const activity = useActivity({ signedIn });
  useMarkRead(chat.data ? activity.data : undefined, id);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [reporting, setReporting] = useState<ChatMessage | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const rules = useRulesAccepted(signedIn && member);
  const acceptRules = useAcceptRules();
  const qc = useQueryClient();
  const reloadChat = () => { qc.setQueryData<ChatData>(chatKey(id ?? ""), (x) => (x ? { ...x, fullAt: 0 } : x)); void chat.refetch(); };
  const list = useRef<FlatList<ChatRow>>(null);
  const lastCount = useRef(0);
  const tz = d?.club_timezone ?? "Asia/Beirut";
  const messages = chat.data?.messages ?? [];
  const rows = useMemo(() => chatRows(messages, tz), [messages, tz]);

  // new messages: followed when at the bottom (onContentSizeChange), otherwise counted for the pill
  useEffect(() => {
    const added = messages.slice(lastCount.current).filter((m) => m.profile_id !== me).length;
    if (lastCount.current > 0 && !atBottom && added > 0) setUnseen((n) => n + added);
    lastCount.current = messages.length;
  }, [messages, me]); // eslint-disable-line react-hooks/exhaustive-deps

  const w = d ? gameWhen(d.start_at, d.end_at, tz) : null;
  const title = d && w ? `${sportName(d.sport)} · ${w.day.split(" ")[0]} ${w.time.split("–")[0]}` : "Chat";
  const page = (body: React.ReactNode) => (
    <View style={styles.page}>
      <Stack.Screen options={{
        title,
        headerTitle: () => (
          <View accessibilityRole="header">
            <Text variant="strong" numberOfLines={1}>{title}</Text>
            {d?.club_name ? <Text variant="caption" numberOfLines={1}>{d.club_name}</Text> : null}
          </View>
        ),
        headerRight: d ? () => (
          <Pressable accessibilityRole="button" accessibilityLabel="Game details" hitSlop={8} onPress={() => router.navigate({ pathname: "/game/[id]", params: { id: d.match_id } })} style={styles.headerAction}>
            <Text style={styles.headerActionText} maxFontSizeMultiplier={1.3}>Game</Text>
          </Pressable>
        ) : undefined,
      }} />
      {body}
    </View>
  );

  if (session.status === "signed-out") return page(<SignInPrompt title="Sign in to see the chat" body="Chat is for the players in a game." />);
  if (!CHAT_AVAILABLE) return page(<Empty title="Not in the app yet" body="Chat arrives in a later update." />);
  if (game.isPending) return page(<Loading label="Loading the chat" />);
  if (game.error) return page(<ErrorState error={game.error} onRetry={() => void game.refetch()} />);
  if (!d || !member) return page(<Empty title="Chat is for the players in this game" body="You're no longer in this game." />);

  const state = composerState({ member, cancelled: d.status === "cancelled", finished: d.finished }, online);
  const send = async (rulesJustAccepted = false) => {
    const body = text.trim();
    if (!body || body.length > MESSAGE_MAX || !state.canSend) return;
    // M3-S: the community rules, once, before the first message
    if (SAFETY_AVAILABLE && !rulesJustAccepted && rules.data === false) { setRulesOpen(true); return; }
    setText(""); setProblem(null);
    const { id: mid, out } = await actions.send(body);
    if (out.kind === "failed" && !out.retry) {
      // refused (too fast, game cancelled, no longer in it): the message was not saved
      actions.discard(mid);
      if (out.failure.reason === "rules_not_accepted") { setText(body); setRulesOpen(true); return; }
      setText(body);
      setProblem(out.failure.message);
    }
    if (out.kind === "signed-out") router.push("/sign-in");
  };
  const block = (m: ChatMessage) => Alert.alert(`Block ${m.name ?? "this player"}?`,
    "You won't see their messages or games, and they can't join yours. They aren't told. You can unblock them in Profile.", [
      { text: "Cancel", style: "cancel" },
      { text: "Block", style: "destructive", onPress: async () => { const f = await blockPlayer(m.profile_id); if (f) setProblem(f.message); else reloadChat(); } },
    ]);
  const onLong = (m: ChatMessage) => {
    if (m.local) return;
    if (m.profile_id !== me) {
      // report and block: migration M3-S (off until it is applied)
      if (!SAFETY_AVAILABLE || m.blocked) return;
      Alert.alert(m.name ?? "Player", undefined, [
        { text: "Report message", onPress: () => setReporting(m) },
        { text: `Block ${m.name ?? "player"}`, style: "destructive", onPress: () => block(m) },
        { text: "Cancel", style: "cancel" },
      ]);
      return;
    }
    if (m.deleted) return;
    Alert.alert("Delete this message?", "Players will see “Message deleted”.", [
      { text: "Keep", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => { const f = await actions.remove(m.id); if (f) setProblem(f.message); } },
    ]);
  };
  const deleteConversation = () => Alert.alert("Delete this conversation?", "It's removed for you only. The other players keep it.", [
    { text: "Keep", style: "cancel" },
    { text: "Delete", style: "destructive", onPress: async () => {
      const out = await gameActions.run({ kind: "hide", hidden: true });
      if (out.kind === "done") router.back();
      else if (out.kind !== "signed-out") setProblem(out.failure.message);
    } },
  ]);

  const body = (() => {
    if (!chat.data && chat.error) return <ErrorState error={chat.error} onRetry={() => void chat.refetch()} />;
    if (!chat.data && !online) return <Empty title="You're offline" body="Connect to the internet to see the chat." />;
    if (!chat.data) return <Loading label="Loading messages" />;
    return null;
  })();

  return page(
    <KeyboardAware>
      {body ?? (
        <View style={{ flex: 1 }}>
          <FlatList
            ref={list}
            data={rows}
            keyExtractor={(r) => r.key}
            contentContainerStyle={[styles.list, rows.length === 0 && { flexGrow: 1, justifyContent: "center" }]}
            ListEmptyComponent={<Empty title="No messages yet" body="Say hello to the players in this game." />}
            onContentSizeChange={() => { if (atBottom) list.current?.scrollToEnd({ animated: false }); }}
            onScroll={(e) => {
              const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
              const bottom = contentOffset.y + layoutMeasurement.height >= contentSize.height - 48;
              if (bottom !== atBottom) setAtBottom(bottom);
              if (bottom && unseen) setUnseen(0);
            }}
            scrollEventThrottle={100}
            renderItem={({ item }) => item.kind === "day"
              ? <Text variant="caption" style={styles.day} accessibilityRole="header">{item.label}</Text>
              : <Bubble r={item} mine={item.m.profile_id === me} tz={tz} onLong={onLong} onRetry={(mid) => void actions.retry(mid)} />}
            testID="chat-list"
          />
          {unseen > 0 ? (
            <Pressable accessibilityRole="button" accessibilityLabel={`${unseen} new ${unseen === 1 ? "message" : "messages"}. Show them`} style={styles.pill}
                       onPress={() => { list.current?.scrollToEnd({ animated: true }); setUnseen(0); }}>
              <Text style={styles.pillText}>New messages ↓</Text>
            </Pressable>
          ) : null}
        </View>
      )}
      <View style={[styles.composer, { paddingBottom: insets.bottom + space.sm }]}>
        {problem ? <Text style={styles.problem} accessibilityRole="alert" accessibilityLiveRegion="polite" testID="chat-problem">{problem}</Text> : null}
        {state.canSend ? (
          <View style={styles.inputRow}>
            <TextInput
              value={text}
              onChangeText={(t) => { setText(t); if (problem) setProblem(null); }}
              placeholder="Message the group"
              placeholderTextColor={color.booked}
              accessibilityLabel="Message the group"
              multiline
              maxFontSizeMultiplier={MAX_FONT_SCALE}
              style={styles.input}
              testID="chat-input"
            />
            <Pressable
              accessibilityRole="button" accessibilityLabel="Send"
              accessibilityState={{ disabled: !text.trim() || text.length > MESSAGE_MAX }}
              disabled={!text.trim() || text.length > MESSAGE_MAX}
              onPress={() => void send()}
              style={({ pressed }) => [styles.send, (!text.trim() || text.length > MESSAGE_MAX) && styles.sendOff, pressed && { opacity: 0.7 }]}
              testID="chat-send"
            >
              <Icon name="send" size={22} color={color.onDark} strokeWidth={2.2} />
            </Pressable>
          </View>
        ) : (
          <View style={{ gap: space.sm }}>
            <Text variant="secondary" testID="chat-readonly">{state.reason}</Text>
            {state.canDeleteConversation ? <Button label="Delete conversation" variant="secondary" onPress={deleteConversation} /> : null}
          </View>
        )}
        {state.canSend && text.length >= COUNTER_FROM ? (
          <Text variant="caption" style={[styles.counter, text.length > MESSAGE_MAX && { color: color.danger }]} accessibilityLiveRegion="polite">{text.length}/{MESSAGE_MAX}</Text>
        ) : null}
      </View>
      {SAFETY_AVAILABLE ? (
        <>
          <ReportSheet visible={!!reporting} what="message" onClose={() => setReporting(null)}
                       onSend={async (reason, note) => (await reportContent("message", reporting!.id, reason, note))?.message ?? null}
                       onBlock={reporting ? () => block(reporting) : undefined} />
          <RulesSheet visible={rulesOpen} onClose={() => setRulesOpen(false)}
                      onAgree={async () => { const f = await acceptRules(); if (!f) { setRulesOpen(false); void send(true); } return f?.message ?? null; }} />
        </>
      ) : null}
    </KeyboardAware>,
  );
}

function Bubble({ r, mine, tz, onLong, onRetry }: { r: Extract<ChatRow, { kind: "msg" }>; mine: boolean; tz: string; onLong: (m: ChatMessage) => void; onRetry: (id: string) => void }) {
  const { m } = r;
  const who = mine ? "You" : m.name ?? "Player";
  const time = hhmm(m.created_at, tz);
  const status = m.local === "sending" ? "Sending…" : m.local === "failed" ? "Not sent — tap to retry" : null;
  const shown = m.deleted ? "Message deleted" : m.blocked ? "Message from a player you blocked" : m.body;
  const spoken = `${who}, ${time}: ${shown}${status ? `. ${status}` : ""}`;
  return (
    <View style={[styles.msgWrap, mine ? styles.right : styles.left, r.first && { marginTop: space.sm }]}>
      {!mine && r.first ? <Text variant="caption" style={styles.name}>{who}</Text> : null}
      <Pressable
        accessibilityLabel={spoken}
        accessibilityHint={m.local === "failed" ? "Sends it again" : mine && !m.deleted && !m.local ? "Long press to delete" : undefined}
        onLongPress={() => onLong(m)}
        onPress={m.local === "failed" ? () => onRetry(m.id) : undefined}
        delayLongPress={350}
        style={[styles.bubble, mine ? styles.mine : styles.theirs, m.local === "failed" && styles.failed]}
        testID={`msg-${m.id}`}
      >
        <Text style={m.deleted || m.blocked ? styles.deleted : styles.body}>{shown}</Text>
      </Pressable>
      {status ? <Text variant="caption" style={m.local === "failed" ? { color: color.danger } : undefined}>{status}</Text>
        : r.last ? <Text variant="caption">{time}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.ground },
  list: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: 2 },
  day: { alignSelf: "center", marginVertical: space.md, color: color.muted },
  msgWrap: { maxWidth: "82%", gap: 2, marginTop: 2 },
  left: { alignSelf: "flex-start" },
  right: { alignSelf: "flex-end", alignItems: "flex-end" },
  name: { color: color.ink, fontFamily: font.semibold },
  bubble: { paddingHorizontal: space.md, paddingVertical: space.sm + 2, borderRadius: radius.lg },
  mine: { backgroundColor: color.cedarSoft },
  theirs: { backgroundColor: color.card, borderWidth: 1, borderColor: color.line },
  failed: { borderWidth: 1, borderColor: color.danger },
  body: { fontFamily: font.regular, fontSize: 16, lineHeight: 22, color: color.ink },
  deleted: { fontFamily: font.regular, fontStyle: "italic", fontSize: 15, lineHeight: 20, color: color.muted },
  pill: {
    position: "absolute", bottom: space.md, alignSelf: "center", backgroundColor: color.card, borderRadius: radius.pill,
    borderWidth: 1, borderColor: color.line, paddingHorizontal: space.lg, minHeight: 40, justifyContent: "center",
  },
  pillText: { fontFamily: font.semibold, fontSize: 15, color: color.ink },
  composer: { borderTopWidth: 1, borderTopColor: color.line, backgroundColor: color.card, paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.xs },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: space.sm },
  input: {
    flex: 1, minHeight: TOUCH, maxHeight: 5 * 22 + 20, backgroundColor: color.ground, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingTop: 12, paddingBottom: 12, fontFamily: font.regular, fontSize: 16, lineHeight: 22, color: color.ink,
  },
  send: { width: TOUCH, height: TOUCH, borderRadius: TOUCH / 2, backgroundColor: color.cedar, alignItems: "center", justifyContent: "center" },
  sendOff: { backgroundColor: color.booked },
  counter: { alignSelf: "flex-end" },
  problem: { color: color.danger },
  headerAction: { minHeight: TOUCH, justifyContent: "center", paddingHorizontal: space.xs },
  headerActionText: { fontFamily: font.semibold, fontSize: 16, color: color.cedarDeep },
});
