import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, FlatList, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { AttachMenu } from "./AttachMenu";
import type { MessageBlock, Reaction, RosterAgent } from "../api";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { useResolvedScheme } from "../theme/appearance";
import { Avatar, colorFor } from "../ui/Avatar";
import { CircleButton } from "../ui/CircleButton";
import { IconChevronDown, IconCopy, IconPlus, IconReplyAction, IconSelectText } from "../ui/icons";
import { PillButton } from "../ui/PrimaryButton";
import { KeyboardLift } from "../ui/KeyboardLift";
import { Sheet } from "../ui/Sheet";
import { useEvent } from "../ui/use-event";
import * as Haptics from "expo-haptics";
import { MessageBlocks, type BlockHandlers } from "./blocks";
import { innerTouching } from "./MarkdownText";
import { Composer } from "./Composer";
import { messagePlainText } from "./markdown";
import { MessageMenu, ReactionChips, type BubbleFrame } from "./Reactions";
import { SelectTextSheet, copyText } from "./SelectTextSheet";
import { RoomActivityBar } from "./RoomActivityBar";
import { SendButton } from "./SendButton";
import { startsTimeGroup, timeLabel } from "./time-label";
import type { RoomActivityPhase } from "./room-activity";

export type Bubble = {
  id: string;
  author: string;
  agentId: string | null;
  mine: boolean;
  body: string;
  /** ISO timestamp for thread ordering (server createdAt or client pending time). */
  sortAt: string;
  time: string;
  blocks?: MessageBlock[] | null;
  replyTo?: string | null;
  replyPreview?: string | null;
  via?: string | null;
  /** Group→1:1 relay caption: "Message from X" or "Messaged N Bots". */
  relay?: {
    kind: "from" | "to";
    peers: { id: string; label: string }[];
    /** The team chat this badge came from; opens read-only in the sheet. */
    sourceConversationId?: string | null;
  } | null;
  reactions?: Reaction[];
};

/** One line of a team chat shown read-only under a relay badge. */
export type TeamChatLine = { id: string; author: string; time: string; body: string };

export type ComposerAttachment = {
  id: string;
  kind: "image" | "file";
  url: string;
  name?: string;
};

/** How far a bubble can be pulled, and how far it must go before letting go replies. */
const SWIPE_TRAVEL = 88;
const SWIPE_TRIGGER = 64;
/** Sideways movement before a touch counts as a pull rather than a tap or a scroll. */
const SWIPE_SLOP = 14;
/** A touch that starts this close to the left edge is the system's go-back swipe. */
const EDGE_GUARD = 28;

function tapLight(): void {
  if (process.env.EXPO_OS === "ios") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

/**
 * Wraps a bubble with pull-right-to-reply.
 * Why it does not go back any more: iOS 26 treats a rightward swipe anywhere
 * as Back. The chat screen now keeps Back to the left edge (see app/_layout),
 * and this gesture ignores touches that start on that edge, so the two never
 * compete: from the edge it is Back, on a bubble it is Reply.
 * The pull runs on the UI thread, so the bubble stays under the finger even
 * while messages are arriving. It starts only on a clearly sideways pull
 * (about 25° or flatter), so a scroll that drifts never turns into a reply,
 * and a stationary hold never starts it, so the long-press menu keeps working.
 * Past the trigger the ↩ is fully shown and a light tap says "let go to
 * reply"; the bubble then springs home with the speed it was let go at.
 * A drag that starts on a table belongs to the table.
 * Input: swipe callback + children. Output: the gesture wrapper.
 */
function SwipeableBubble({
  onSwipe,
  onActive,
  children,
}: {
  onSwipe: () => void;
  /** Told when a pull starts and ends, so the list can hold still meanwhile. */
  onActive: (active: boolean) => void;
  children: ReactNode;
}) {
  const x = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const pulling = useSharedValue(false);
  const armed = useSharedValue(false);
  // Latest callbacks: the gesture is built once and must not call stale ones.
  const reply = useEvent(onSwipe);
  const hold = useEvent(onActive);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .manualActivation(true)
        .onTouchesDown((event, state) => {
          const touch = event.allTouches[0];
          if (!touch || event.numberOfTouches > 1 || touch.absoluteX < EDGE_GUARD) {
            state.fail();
            return;
          }
          startX.set(touch.absoluteX);
          startY.set(touch.absoluteY);
        })
        .onTouchesMove((event, state) => {
          if (pulling.get()) return;
          const touch = event.allTouches[0];
          if (!touch) return;
          const dx = touch.absoluteX - startX.get();
          const dy = Math.abs(touch.absoluteY - startY.get());
          if (innerTouching.get() || dx < -SWIPE_SLOP || (dy > 10 && dx < dy * 2.2)) {
            state.fail();
          } else if (dx > SWIPE_SLOP && dx > dy * 2.2) {
            state.activate();
          }
        })
        .onStart(() => {
          pulling.set(true);
          scheduleOnRN(hold, true);
        })
        .onUpdate((event) => {
          // Measured from where the pull was recognized, so the bubble does not jump.
          const pulled = Math.max(0, event.translationX - SWIPE_SLOP);
          // Free up to the trigger, then it resists: there is nothing further to reach.
          const eased = pulled <= SWIPE_TRIGGER ? pulled : SWIPE_TRIGGER + (pulled - SWIPE_TRIGGER) * 0.35;
          x.set(Math.min(SWIPE_TRAVEL, eased));
          armed.set(pulled >= SWIPE_TRIGGER);
        })
        .onEnd(() => {
          // If the system takes the touch anyway, a pull already past the mark still replies.
          if (armed.get()) scheduleOnRN(reply);
        })
        .onFinalize((event) => {
          if (pulling.get()) {
            pulling.set(false);
            scheduleOnRN(hold, false);
          }
          armed.set(false);
          x.set(withSpring(0, { duration: 400, dampingRatio: 0.8, velocity: event.velocityX ?? 0 }));
        }),
    [x, startX, startY, pulling, armed, reply, hold],
  );

  // One tap as the pull crosses the mark, in the same frame as the arrow filling in.
  useAnimatedReaction(
    () => armed.get(),
    (now, before) => {
      if (now && !before) scheduleOnRN(tapLight);
    },
  );

  const bodyStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }));
  const hintStyle = useAnimatedStyle(() => {
    const shown = interpolate(x.get(), [12, SWIPE_TRIGGER], [0, 1], Extrapolation.CLAMP);
    return { opacity: shown, transform: [{ scale: 0.6 + shown * 0.4 }] };
  });

  return (
    <View style={styles.swipeWrap}>
      {/* Out of the row's flow and under the bubble, so showing it never shifts anything. */}
      <Animated.Text style={[styles.swipeHint, hintStyle]} pointerEvents="none">
        ↩
      </Animated.Text>
      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.swipeBody, bodyStyle]}>{children}</Animated.View>
      </GestureDetector>
    </View>
  );
}

/**
 * Compact badge for team traffic mirrored into the private chat:
 * "Message from X" for what a teammate said, "Messaged X" (or "N Bots") for
 * what the lead asked the team.
 * Why: the full conversation stays in the team chat; the private chat only
 * gets a chip, so the person sees that work is moving without the noise.
 * Tap opens a read-only sheet with the message and the team chat around it.
 */
function RelayBadge({
  kind,
  author,
  authorId,
  peers,
  roster,
  onPress,
}: {
  kind: "from" | "to";
  author: string;
  authorId: string | null;
  peers: { id: string; label: string }[];
  roster: Map<string, RosterAgent>;
  onPress: () => void;
}) {
  const faces = kind === "to" ? peers.map((peer) => ({ id: peer.id, face: roster.get(peer.id) })) : [{ id: authorId ?? author, face: authorId ? roster.get(authorId) : undefined }];
  const name = kind === "to" ? (peers.length === 1 ? (peers[0]?.label ?? "Bot") : `${peers.length} Bots`) : author;
  const caption = kind === "to" ? "Messaged " : "Message from ";
  return (
    <Pressable
      style={styles.relayBadge}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${caption}${name}. Tap to read.`}
    >
      <Text style={styles.relayCaptionText}>{caption}</Text>
      {faces.slice(0, 3).map(({ id, face }, index) => (
        <View key={`${id}-${index}`} style={index > 0 ? styles.relayFaceOverlap : undefined}>
          <Avatar
            id={id}
            size={14}
            round
            shape={face?.markShape ?? null}
            color={face?.markColor ?? null}
            material={face?.markMaterial ?? null}
            style={face?.markStyle ?? null}
            gender={face?.markGender ?? null}
            photo={face?.avatarUrl ?? null}
          />
        </View>
      ))}
      <Text style={styles.relayCaptionName}> {name}</Text>
    </Pressable>
  );
}

/** What one message row can ask the screen to do. None of these ever change identity. */
type RowActions = {
  reply: (bubble: Bubble) => void;
  hold: (bubble: Bubble) => void;
  react: (bubble: Bubble, emoji: string) => void;
  openRelay: (bubble: Bubble) => void;
  jumpTo: (messageId: string) => void;
  keepView: (messageId: string, view: View | null) => void;
  swiping: (active: boolean) => void;
};

/**
 * One message in the thread.
 * Why: this used to be drawn inline by the list, so every bubble (markdown,
 * tables, pictures and all) was rebuilt on each keystroke in the composer and
 * on each poll. Memoized, a row redraws only when its own message, its face,
 * or the theme changes.
 * Input: the message, what the screen knows about its author, and stable handlers.
 * Output: the row.
 */
const MessageRow = memo(function MessageRow({
  item,
  showTime,
  face,
  highlighted,
  roster,
  actions,
  blockHandlers,
}: {
  item: Bubble;
  showTime: boolean;
  face: RosterAgent | null;
  highlighted: boolean;
  roster: Map<string, RosterAgent>;
  actions: RowActions;
  blockHandlers: BlockHandlers;
  /** Only here so a theme change redraws the row; the styles are read from the module. */
  scheme: string;
}) {
  const blocks: MessageBlock[] =
    item.blocks && item.blocks.length > 0 ? item.blocks : [{ kind: "text", markdown: item.body }];
  const nameColor = item.mine ? colors.text : colorFor(item.agentId ?? item.author);
  const relay = item.relay;
  return (
    <View>
      {showTime ? <Text style={styles.time}>{timeLabel(item.sortAt)}</Text> : null}
      {relay ? (
        <View style={styles.relayWrap}>
          <RelayBadge
            kind={relay.kind}
            author={item.author}
            authorId={item.agentId}
            peers={relay.peers}
            roster={roster}
            onPress={() => actions.openRelay(item)}
          />
        </View>
      ) : (
        <View style={[styles.row, item.mine ? styles.rowMine : styles.rowTheirs]}>
          {!item.mine ? (
            <Avatar
              id={item.agentId ?? item.author}
              size={36}
              round
              shape={face?.markShape ?? null}
              color={face?.markColor ?? null}
              material={face?.markMaterial ?? null}
              style={face?.markStyle ?? null}
              gender={face?.markGender ?? null}
              photo={face?.avatarUrl ?? null}
            />
          ) : null}
          <View style={styles.column}>
            {!item.mine ? (
              <Text style={[styles.author, { color: nameColor }]} numberOfLines={1}>
                {item.author}
                {item.via ? <Text style={styles.viaInline}> · via {item.via}</Text> : null}
              </Text>
            ) : null}
            <SwipeableBubble onSwipe={() => actions.reply(item)} onActive={actions.swiping}>
              <Pressable
                ref={(view) => actions.keepView(item.id, view)}
                onLongPress={() => actions.hold(item)}
                delayLongPress={350}
                // Words sit in bubbles; cards, pictures and files stand on their own.
                style={[styles.stack, item.mine ? styles.stackMine : styles.stackTheirs, highlighted ? styles.stackHighlight : null]}
                accessibilityLabel={`${item.author}. ${item.body}`}
              >
                <MessageBlocks
                  blocks={blocks}
                  bubbleStyle={[styles.bubble, item.mine ? styles.bubbleMine : styles.bubbleTheirs]}
                  lead={
                    item.replyTo && item.replyPreview ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Jump to replied message: ${item.replyPreview}`}
                        onPress={() => actions.jumpTo(item.replyTo!)}
                        hitSlop={6}
                      >
                        <Text style={styles.quote}>↩ {item.replyPreview}</Text>
                      </Pressable>
                    ) : null
                  }
                  messageId={item.id}
                  {...blockHandlers}
                />
                <ReactionChips reactions={item.reactions ?? []} onPick={(emoji) => actions.react(item, emoji)} />
              </Pressable>
            </SwipeableBubble>
          </View>
        </View>
      )}
    </View>
  );
});

/**
 * Shows one rich thread with the composer and attachments.
 * Why: images/files attach via the + sheet and ride the same send as blocks —
 * no second input row. Holding a bubble opens reactions plus Reply, Copy, and
 * Select Text.
 * Input: agent, bubbles, draft/sending/typing/error, reply target,
 * attachments + sheet flag, and chat actions.
 * Output: the conversation screen.
 */
export function ChatScreen({
  agent,
  conversationId,
  title,
  subtitle,
  contextRing,
  members,
  roster,
  messages,
  loading = false,
  draft,
  sending,
  roomActivity,
  isGroup,
  error,
  replyTo,
  attachments,
  onDraft,
  onSend,
  onPickImage,
  onPickCamera,
  onPickFile,
  onRemoveAttachment,
  onReply,
  onClearReply,
  onPollSubmit,
  onQuestionPick,
  onSecretSubmit,
  onReact,
  onApprove,
  onDeny,
  onFetchBlob,
  onLoadTeamChat,
  onLoadOlder,
  onBack,
  onDesktop,
  onAgentMenu,
  onOpenAgent,
}: {
  agent: RosterAgent;
  conversationId: string;
  title: string;
  subtitle: string;
  /** Shown inside the message field on the right when context stats loaded. */
  contextRing?: { share: number; hint: string } | null;
  members: RosterAgent[];
  /** Full account roster — used for relay captions and agent-card taps. */
  roster?: RosterAgent[];
  messages: Bubble[];
  /** True while the first page of a chat is still on its way: no "start of chat" line yet. */
  loading?: boolean;
  draft: string;
  sending: boolean;
  roomActivity: RoomActivityPhase | null;
  isGroup: boolean;
  error: string | null;
  replyTo: Bubble | null;
  attachments: ComposerAttachment[];
  onDraft: (value: string) => void;
  onSend: () => void;
  onPickImage: () => void;
  onPickCamera: () => void;
  onPickFile: () => void;
  onRemoveAttachment: (id: string) => void;
  onReply: (bubble: Bubble) => void;
  onClearReply: () => void;
  onPollSubmit: (text: string) => void;
  onQuestionPick: (messageId: string, pick: { value: string; label: string }) => void;
  onSecretSubmit: (name: string, secret: string) => Promise<void>;
  onReact: (bubble: Bubble, emoji: string) => void;
  onApprove: (approvalId?: string, always?: boolean) => void;
  onDeny: (approvalId?: string) => void;
  onFetchBlob: (messageId: string, index: number) => Promise<{ url?: string; previewUrl?: string }>;
  /** Loads a team chat's recent messages for the read-only badge sheet. */
  onLoadTeamChat?: (conversationId: string) => Promise<TeamChatLine[]>;
  /** Called when the person scrolls up to the oldest loaded message. */
  onLoadOlder?: () => void;
  onBack: () => void;
  onDesktop: () => void;
  onAgentMenu: () => void;
  /** Opens a teammate's private chat (agent-card tap / relay avatar). */
  onOpenAgent?: (agentId: string) => void;
}) {
  const scheme = useResolvedScheme();
  const insets = useSafeAreaInsets();
  const [attachOpen, setAttachOpen] = useState(false);
  const listRef = useRef<FlatList<Bubble>>(null);
  // Room under the composer: the home indicator or the Android navigation bar.
  const bottomPad = Math.max(8, insets.bottom);
  const composerBottom = bottomPad + 52;
  const canSend = (draft.trim().length > 0 || attachments.length > 0) && !sending;
  // The held bubble and where it sits, so the menu opens right beside it.
  const [held, setHeld] = useState<{ bubble: Bubble; frame: BubbleFrame } | null>(null);
  const bubbleViews = useRef(new Map<string, View>());
  const openMenu = useEvent((bubble: Bubble): void => {
    bubbleViews.current.get(bubble.id)?.measureInWindow((x, y, width, height) => {
      if (process.env.EXPO_OS === "ios") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setHeld({ bubble, frame: { x, y, width, height } });
    });
  });
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [relaySheet, setRelaySheet] = useState<Bubble | null>(null);
  const [relayOpen, setRelayOpen] = useState(false);
  const [selectText, setSelectText] = useState<string | null>(null);
  /**
   * Opens the badge sheet on that one message.
   * Why only it: the sheet used to load the whole team chat under the message,
   * and the one line the person tapped was lost among forty.
   */
  const openRelaySheet = useEvent((bubble: Bubble) => {
    setRelaySheet(bubble);
    setRelayOpen(true);
  });
  // Newest-first + inverted FlatList opens on the latest message with no
  // top→bottom scroll animation (scrollToEnd on layout was the jump).
  const thread = useMemo(() => [...messages].reverse(), [messages]);
  const rosterFaces = useMemo(() => {
    const map = new Map<string, RosterAgent>();
    map.set(agent.id, agent);
    for (const member of members) map.set(member.id, member);
    for (const row of roster ?? []) map.set(row.id, row);
    return map;
  }, [agent, members, roster]);
  // Read back up the thread: a button takes the person down to the latest
  // message, and counts what arrived while they were reading.
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const newest = thread[0];
  const seenNewest = useRef(newest?.id);
  useEffect(() => {
    if (!newest || newest.id === seenNewest.current) return;
    seenNewest.current = newest.id;
    if (away && !newest.mine) setUnseen((count) => count + 1);
  }, [newest, away]);
  const toLatest = useEvent(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
    setUnseen(0);
  });
  useEffect(() => {
    setAway(false);
    setUnseen(0);
    setHeld(null);
    setHighlightId(null);
    setAttachOpen(false);
    setRelaySheet(null);
    setRelayOpen(false);
    setSelectText(null);
  }, [conversationId]);

  /** Scrolls the inverted thread to the parent of a swipe-reply. */
  const scrollToReply = useEvent((messageId: string): void => {
    const index = thread.findIndex((row) => row.id === messageId);
    if (index < 0) return;
    listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.35 });
    setHighlightId(messageId);
    setTimeout(() => {
      setHighlightId((current) => (current === messageId ? null : current));
    }, 1400);
  });

  // Handlers the rows keep for as long as the screen lives. The route hands
  // down new functions on every render; these wrappers hide that from the rows.
  const reply = useEvent(onReply);
  const react = useEvent(onReact);
  const loadOlder = useEvent(onLoadOlder);
  const actions = useMemo<RowActions>(
    () => ({
      reply,
      hold: openMenu,
      react,
      openRelay: openRelaySheet,
      jumpTo: scrollToReply,
      keepView: (messageId, view) => {
        if (view) bubbleViews.current.set(messageId, view);
        else bubbleViews.current.delete(messageId);
      },
      swiping: (active) => listRef.current?.setNativeProps({ scrollEnabled: !active }),
    }),
    [reply, openMenu, react, openRelaySheet, scrollToReply],
  );
  const approve = useEvent(onApprove);
  const deny = useEvent(onDeny);
  const submitPoll = useEvent(onPollSubmit);
  const pickQuestion = useEvent(onQuestionPick);
  const submitSecret = useEvent(onSecretSubmit);
  const openDesktop = useEvent(onDesktop);
  const openAgent = useEvent(onOpenAgent);
  const fetchBlob = useEvent(onFetchBlob);
  const facesRef = useRef(rosterFaces);
  facesRef.current = rosterFaces;
  const blockHandlers = useMemo<BlockHandlers>(
    () => ({
      onApprove: approve,
      onDeny: deny,
      onSubmitPoll: submitPoll,
      onQuestionPick: pickQuestion,
      onSubmitSecret: submitSecret as BlockHandlers["onSubmitSecret"],
      onOpenDesktop: openDesktop,
      onOpenAgent: openAgent,
      agentInfo: (id: string) => facesRef.current.get(id),
      fetchBlob: fetchBlob as BlockHandlers["fetchBlob"],
    }),
    [approve, deny, submitPoll, pickQuestion, submitSecret, openDesktop, openAgent, fetchBlob],
  );
  const renderRow = useCallback(
    ({ item, index }: { item: Bubble; index: number }) => {
      // thread is newest-first; the chronologically older neighbor is at index+1.
      const previous = thread[index + 1];
      return (
        <MessageRow
          item={item}
          showTime={startsTimeGroup(item.sortAt, previous?.sortAt)}
          face={item.agentId ? (rosterFaces.get(item.agentId) ?? null) : null}
          highlighted={highlightId === item.id}
          roster={rosterFaces}
          actions={actions}
          blockHandlers={blockHandlers}
          scheme={scheme}
        />
      );
    },
    [thread, rosterFaces, highlightId, actions, blockHandlers, scheme],
  );
  // @ mention autocomplete: matches a trailing @word in the draft and offers
  // room members starting with it. A trailing space (finished mention) hides it.
  const mentionQuery = /@([A-Za-z0-9_-]*)$/.exec(draft)?.[1]?.toLowerCase() ?? null;
  const mentionCandidates =
    mentionQuery === null
      ? []
      : members.filter((member) => member.name.toLowerCase().startsWith(mentionQuery)).slice(0, 5);

  /**
   * Inserts the picked member mention at the trailing @word.
   * Input: the member name. Output: nothing. Draft keeps "@name " format.
   */
  function pickMention(name: string): void {
    const at = draft.lastIndexOf("@");
    if (at < 0) {
      return;
    }
    onDraft(`${draft.slice(0, at)}@${name} `);
  }

  return (
    // Clips the thread at the header while the keyboard slides it upward.
    <View style={styles.screen}>
    <KeyboardLift style={styles.avoid} slide absorb={bottomPad - 8}>
      {contextRing?.hint ? (
        <Text style={styles.contextLine} numberOfLines={1}>
          {contextRing.hint}
        </Text>
      ) : null}
      <View style={styles.threadList}>
      <FlatList
        ref={listRef}
        key={conversationId}
        style={styles.threadList}
        inverted
        // Inverted: an offset of 0 is the latest message.
        onScroll={(event) => {
          const far = event.nativeEvent.contentOffset.y > 480;
          if (far !== away) setAway(far);
          if (!far && unseen > 0) setUnseen(0);
        }}
        scrollEventThrottle={64}
        data={thread}
        keyExtractor={keyOfBubble}
        renderItem={renderRow}
        // The list is inverted, so its "end" is the top: the oldest message.
        onEndReached={loadOlder}
        onEndReachedThreshold={0.5}
        contentContainerStyle={styles.thread}
        keyboardShouldPersistTaps="handled"
        // iOS: pulling the thread down drags the keyboard away with the finger.
        keyboardDismissMode={process.env.EXPO_OS === "ios" ? "interactive" : "none"}
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        windowSize={9}
        onScrollToIndexFailed={({ index }) => {
          // Off-screen rows need a layout pass before scrollToIndex works.
          setTimeout(() => {
            listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.35 });
          }, 120);
        }}
        ListEmptyComponent={
          roomActivity ? null : loading ? (
            <View style={styles.emptyInvert}>
              <View style={styles.empty}>
                <ActivityIndicator color={colors.muted} />
              </View>
            </View>
          ) : (
            // Inverted lists flip empty content; un-flip so copy reads upright.
            <View style={styles.emptyInvert}>
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>This is the start of {title}</Text>
                <Text style={styles.emptyHint}>
                  {members.length > 0 ? "Type @ to mention a member." : `${title} will say hello in a moment.`}
                </Text>
              </View>
            </View>
          )
        }
      />
      {away ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={unseen > 0 ? `Go to the latest message, ${unseen} new` : "Go to the latest message"}
          hitSlop={6}
          onPress={toLatest}
          style={({ pressed }) => [styles.toLatest, pressed ? styles.toLatestPressed : null]}
        >
          <IconChevronDown />
          {unseen > 0 ? (
            <View style={styles.toLatestBadge}>
              <Text style={styles.toLatestCount}>{unseen > 99 ? "99+" : unseen}</Text>
            </View>
          ) : null}
        </Pressable>
      ) : null}
      </View>
      {roomActivity ? (
        <RoomActivityBar phase={roomActivity} agent={agent} isGroup={isGroup} />
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {attachments.length > 0 ? (
        <View style={styles.chips}>
          {attachments.map((attachment) => (
            <View key={attachment.id} style={styles.chip}>
              {attachment.kind === "image" ? (
                <Image source={{ uri: attachment.url }} style={styles.thumb} />
              ) : (
                <Text style={styles.fileGlyph}>📄</Text>
              )}
              <Text style={styles.chipName} numberOfLines={1}>
                {attachment.name ?? "image"}
              </Text>
              <Pressable onPress={() => onRemoveAttachment(attachment.id)} accessibilityLabel="Remove attachment">
                <Text style={styles.chipX}>✕</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      {mentionCandidates.length > 0 ? (
        <View style={styles.mentions}>
          {mentionCandidates.map((member) => (
            <Pressable key={member.id} style={styles.mentionRow} onPress={() => pickMention(member.name)}>
              <Avatar
                id={member.id}
                size={24}
                round
                shape={member.markShape}
                color={member.markColor}
                material={member.markMaterial}
                style={member.markStyle}
                gender={member.markGender}
                photo={member.avatarUrl}
              />
              <Text style={styles.mentionName}>{member.name}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Sheet open={relayOpen} onClose={() => setRelayOpen(false)}>
        {relaySheet ? (
            <View style={[styles.relaySheet, { paddingBottom: bottomPad }]}>
                <Text style={styles.relaySheetTitle}>
                  {relaySheet.relay?.kind === "to"
                    ? `Messaged ${relaySheet.relay.peers.map((peer) => peer.label).join(", ") || "the team"}`
                    : `Message from ${relaySheet.author}`}
                </Text>
                <ScrollView style={styles.relaySheetBody}>
                  <MessageBlocks
                    blocks={
                      relaySheet.blocks && relaySheet.blocks.length > 0
                        ? relaySheet.blocks
                        : [{ kind: "text" as const, markdown: relaySheet.body }]
                    }
                    messageId={relaySheet.id}
                    onApprove={onApprove}
                    onDeny={onDeny}
                    onSubmitPoll={onPollSubmit}
                    onQuestionPick={onQuestionPick}
                    onSubmitSecret={onSecretSubmit}
                    onOpenDesktop={onDesktop}
                    onOpenAgent={onOpenAgent}
                    fetchBlob={onFetchBlob}
                  />
                </ScrollView>
                <PillButton label="Close" onPress={() => setRelayOpen(false)} />
              </View>
        ) : null}
      </Sheet>
      <MessageMenu
        open={held !== null}
        onClose={() => setHeld(null)}
        onPick={(emoji) => {
          const bubble = held?.bubble;
          setHeld(null);
          if (bubble) onReact(bubble, emoji);
        }}
        actions={
          held
            ? [
                {
                  label: "Reply",
                  icon: <IconReplyAction />,
                  onPress: () => {
                    setHeld(null);
                    onReply(held.bubble);
                  },
                },
                {
                  label: "Copy",
                  icon: <IconCopy />,
                  group: 1,
                  onPress: () => {
                    setHeld(null);
                    void copyText(messagePlainText(held.bubble.blocks, held.bubble.body));
                  },
                },
                {
                  label: "Select Text",
                  icon: <IconSelectText />,
                  group: 1,
                  onPress: () => {
                    setHeld(null);
                    // iOS drops a sheet presented while another modal is
                    // still closing, so wait out the fade.
                    const text = messagePlainText(held.bubble.blocks, held.bubble.body);
                    setTimeout(() => setSelectText(text), 320);
                  },
                },
              ]
            : []
        }
      />
      <SelectTextSheet text={selectText} onClose={() => setSelectText(null)} />
      <Modal visible={attachOpen} transparent animationType="fade" onRequestClose={() => setAttachOpen(false)}>
        <Pressable style={styles.attachBackdrop} onPress={() => setAttachOpen(false)} accessibilityLabel="Close attach menu">
          <View style={[styles.attachAnchor, { bottom: composerBottom }]} pointerEvents="box-none">
            <AttachMenu
              actions={[
                {
                  icon: "image",
                  label: "Attach Image",
                  onPress: () => {
                    setAttachOpen(false);
                    onPickImage();
                  },
                },
                {
                  icon: "camera",
                  label: "Take Photo",
                  onPress: () => {
                    setAttachOpen(false);
                    onPickCamera();
                  },
                },
                {
                  icon: "folder",
                  label: "Choose File",
                  onPress: () => {
                    setAttachOpen(false);
                    onPickFile();
                  },
                },
              ]}
            />
          </View>
        </Pressable>
      </Modal>
      <View style={[styles.composer, { paddingBottom: bottomPad }]}>
        <CircleButton label="Attach" active={attachOpen} onPress={() => setAttachOpen((open) => !open)}>
          <IconPlus />
        </CircleButton>
        <Composer
          value={draft}
          onChange={onDraft}
          placeholder="Message"
          replyText={replyTo ? messagePlainText(replyTo.blocks, replyTo.body).trim().split("\n")[0] || "Attachment" : null}
          onClearReply={onClearReply}
          contextRing={contextRing}
          canSend={canSend}
          sending={sending}
          onSend={onSend}
        />
        <SendButton onPress={onSend} disabled={!canSend} busy={sending} />
      </View>
    </KeyboardLift>
    </View>
  );
}

function keyOfBubble(message: Bubble): string {
  return message.id;
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, overflow: "hidden" },
  avoid: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    paddingTop: 4,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.control,
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 10,
    maxWidth: "60%",
  },
  pillName: { color: colors.text, fontSize: 16, fontWeight: "600" },
  contextLine: { color: colors.muted, fontSize: 12, textAlign: "center", paddingBottom: 4 },
  titles: { flexShrink: 1 },
  pillSub: { color: colors.muted, fontSize: 12 },
  empty: { alignItems: "center", paddingVertical: 32, gap: 6 },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  emptyHint: { color: colors.muted, fontSize: 14, textAlign: "center", paddingHorizontal: 32 },
  mentions: {
    marginHorizontal: 12,
    marginBottom: 4,
    backgroundColor: colors.control,
    borderRadius: 14,
    overflow: "hidden",
  },
  mentionRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingHorizontal: 12 },
  mentionName: { color: colors.text, fontSize: 16 },
  headerSpacer: { width: 44 },
  threadList: { flex: 1 },
  toLatest: {
    position: "absolute",
    right: 12,
    bottom: 12,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.control,
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 2px 8px rgba(0, 0, 0, 0.25)",
  },
  toLatestPressed: { opacity: 0.7 },
  toLatestBadge: {
    position: "absolute",
    top: -6,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    backgroundColor: colors.online,
    alignItems: "center",
    justifyContent: "center",
  },
  toLatestCount: { color: "#FFFFFF", fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"] },
  // With inverted lists, paddingTop is the visual bottom (near composer).
  thread: { flexGrow: 1, paddingHorizontal: 12, paddingTop: 16, paddingBottom: 12, gap: 8 },
  emptyInvert: { transform: [{ scaleY: -1 }] },
  time: { color: colors.muted, textAlign: "center", fontSize: 13, marginVertical: 10 },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  rowMine: { justifyContent: "flex-end" },
  rowTheirs: { justifyContent: "flex-start" },
  column: { flexShrink: 1, maxWidth: "85%", gap: 2 },
  author: { fontSize: 14, fontWeight: "700", paddingLeft: 12 },
  viaInline: { color: colors.muted, fontWeight: "400", fontSize: 12 },
  swipeWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
  // Lets the bubble narrow to the column instead of growing with a wide table.
  swipeBody: { flexShrink: 1 },
  swipeHint: { position: "absolute", left: 4, color: colors.link, fontSize: 22, fontWeight: "700" },
  bubble: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, gap: 6 },
  bubbleMine: { backgroundColor: colors.online, borderBottomRightRadius: 6 },
  bubbleTheirs: { backgroundColor: colors.bubble, borderBottomLeftRadius: 6 },
  // One message: its bubbles and cards stacked, hugging the speaker's side.
  stack: { gap: 6, borderRadius: 22 },
  stackMine: { alignItems: "flex-end" },
  stackTheirs: { alignItems: "flex-start" },
  stackHighlight: { borderWidth: 1, borderColor: colors.link, padding: 4 },
  relayWrap: { alignItems: "center", paddingHorizontal: 12, marginVertical: 4 },
  relayBadge: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 2,
    backgroundColor: colors.control,
    borderRadius: 14,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  relayCaptionText: { color: colors.muted, fontSize: 12 },
  relayCaptionName: { color: colors.muted, fontSize: 12, fontWeight: "600" },
  relaySheet: { flex: 1, gap: 12, paddingHorizontal: 16, paddingTop: 20 },
  relaySheetTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  relaySheetBody: { flex: 1 },
  relayFaceOverlap: { marginLeft: -5 },
  teamChat: { marginTop: 14, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.line, gap: 10 },
  teamChatTitle: { color: colors.muted, fontSize: 12, fontWeight: "600" },
  teamChatLine: { gap: 2 },
  teamChatAuthor: { color: colors.text, fontSize: 13, fontWeight: "600" },
  teamChatBody: { color: colors.text, fontSize: 14, lineHeight: 20 },
  teamChatMuted: { color: colors.muted, fontSize: 12, fontWeight: "400" },
  quote: { color: colors.muted, fontSize: 13, borderLeftWidth: 2, borderLeftColor: colors.link, paddingLeft: 8, marginBottom: 4 },
  error: { color: colors.danger, paddingHorizontal: 20, paddingBottom: 6, fontSize: 14 },
  replyBar: { backgroundColor: colors.control, marginHorizontal: 12, borderRadius: 10, padding: 8 },
  replyText: { color: colors.text, fontSize: 13 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 12, paddingBottom: 4 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.control,
    borderRadius: 14,
    paddingVertical: 4,
    paddingHorizontal: 8,
    maxWidth: 220,
  },
  thumb: { width: 28, height: 28, borderRadius: 8 },
  fileGlyph: { fontSize: 20 },
  chipName: { color: colors.text, fontSize: 12, flexShrink: 1 },
  chipX: { color: colors.muted, fontSize: 14, paddingHorizontal: 4 },
  attachBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
  attachAnchor: { position: "absolute", left: 10 },
  composer: { flexDirection: "row", alignItems: "flex-end", paddingHorizontal: 8, paddingBottom: 8, gap: 2 },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
