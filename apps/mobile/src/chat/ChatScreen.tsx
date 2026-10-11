import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  FlatList,
  Image,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { AttachMenu } from "./AttachMenu";
import type { MessageBlock, Reaction, RosterAgent } from "../api";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { useResolvedScheme } from "../theme/appearance";
import { Avatar, colorFor } from "../ui/Avatar";
import { CircleButton } from "../ui/CircleButton";
import { IconCopy, IconPlus, IconReplyAction, IconSelectText } from "../ui/icons";
import { PillButton } from "../ui/PrimaryButton";
import * as Haptics from "expo-haptics";
import { MessageBlocks } from "./blocks";
import { isTableTouch } from "./MarkdownText";
import { Composer } from "./Composer";
import { messagePlainText } from "./markdown";
import { MessageMenu, ReactionChips, type BubbleFrame } from "./Reactions";
import { SelectTextSheet, copyText } from "./SelectTextSheet";
import { RoomActivityBar } from "./RoomActivityBar";
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

/**
 * Wraps a bubble with pull-left-to-reply, Telegram style.
 * Why left: a pull to the right is the system's go-back gesture, which won
 * and closed the chat instead of replying. Horizontal drags past the
 * threshold reply; vertical drags stay with the list because activation
 * requires dominant horizontal movement. The bubble follows the finger; past
 * the trigger a ↩ and a light tap say "let go to reply", then it springs home.
 * A stationary hold never activates it, so Pressable long-press (reactions)
 * keeps working. A drag that starts on a table belongs to the table.
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
  const x = useRef(new Animated.Value(0)).current;
  const [hint, setHint] = useState(false);
  // Latest callbacks: the responder is built once and must not call stale ones.
  const calls = useRef({ onSwipe, onActive });
  calls.current = { onSwipe, onActive };
  const armed = useRef(false);
  const finish = (reply: boolean): void => {
    calls.current.onActive(false);
    if (reply) calls.current.onSwipe();
    Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
    armed.current = false;
    setHint(false);
  };
  const responder = useRef(
    PanResponder.create({
      // Starts only on a clearly sideways pull (about 25° or flatter), so a
      // scroll that drifts a little never turns into a reply.
      onMoveShouldSetPanResponder: (_event, gesture) =>
        !isTableTouch() && gesture.dx < -14 && -gesture.dx > Math.abs(gesture.dy) * 2.2,
      onPanResponderGrant: () => calls.current.onActive(true),
      // Once the pull has started it keeps the touch; the list may not take it back.
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_event, gesture) => {
        const pulled = Math.max(0, Math.min(SWIPE_TRAVEL, -gesture.dx));
        x.setValue(-pulled);
        const ready = pulled >= SWIPE_TRIGGER;
        if (ready !== armed.current) {
          armed.current = ready;
          setHint(ready);
          if (ready && process.env.EXPO_OS === "ios") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
      },
      onPanResponderRelease: () => finish(armed.current),
      // If the system takes the touch anyway, a pull already past the mark still replies.
      onPanResponderTerminate: () => finish(armed.current),
    }),
  ).current;
  return (
    <View style={styles.swipeWrap}>
      <Animated.View style={[styles.swipeBody, { transform: [{ translateX: x }] }]} {...responder.panHandlers}>
        {children}
      </Animated.View>
      {/* Out of the row's flow, so showing it never shifts the bubble. */}
      {hint ? <Text style={styles.swipeHint}>↩</Text> : null}
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
  onApprove: (approvalId?: string) => void;
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
  useResolvedScheme();
  const insets = useSafeAreaInsets();
  const [attachOpen, setAttachOpen] = useState(false);
  const listRef = useRef<FlatList<Bubble>>(null);
  const composerBottom = Math.max(8, insets.bottom) + 52;
  const canSend = (draft.trim().length > 0 || attachments.length > 0) && !sending;
  // The held bubble and where it sits, so the menu opens right beside it.
  const [held, setHeld] = useState<{ bubble: Bubble; frame: BubbleFrame } | null>(null);
  const bubbleViews = useRef(new Map<string, View>());
  const openMenu = (bubble: Bubble): void => {
    bubbleViews.current.get(bubble.id)?.measureInWindow((x, y, width, height) => {
      if (process.env.EXPO_OS === "ios") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setHeld({ bubble, frame: { x, y, width, height } });
    });
  };
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [relaySheet, setRelaySheet] = useState<Bubble | null>(null);
  const [selectText, setSelectText] = useState<string | null>(null);
  const [teamChat, setTeamChat] = useState<TeamChatLine[] | null>(null);
  /** Opens the badge sheet and loads the team chat it came from, read-only. */
  const openRelaySheet = (bubble: Bubble) => {
    setRelaySheet(bubble);
    setTeamChat(null);
    const source = bubble.relay?.sourceConversationId;
    if (!source || !onLoadTeamChat) return;
    void onLoadTeamChat(source)
      .then((lines) => setTeamChat(lines))
      .catch(() => setTeamChat([]));
  };
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
  useEffect(() => {
    setHeld(null);
    setHighlightId(null);
    setAttachOpen(false);
    setRelaySheet(null);
    setSelectText(null);
  }, [conversationId]);

  /** Scrolls the inverted thread to the parent of a swipe-reply. */
  function scrollToReply(messageId: string): void {
    const index = thread.findIndex((row) => row.id === messageId);
    if (index < 0) return;
    listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.35 });
    setHighlightId(messageId);
    setTimeout(() => {
      setHighlightId((current) => (current === messageId ? null : current));
    }, 1400);
  }
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
    <View style={styles.screen}>
      {contextRing?.hint ? (
        <Text style={styles.contextLine} numberOfLines={1}>
          {contextRing.hint}
        </Text>
      ) : null}
      <FlatList
        ref={listRef}
        key={conversationId}
        style={styles.threadList}
        inverted
        data={thread}
        keyExtractor={(message) => message.id}
        // The list is inverted, so its "end" is the top: the oldest message.
        onEndReached={onLoadOlder}
        onEndReachedThreshold={0.5}
        contentContainerStyle={styles.thread}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        onScrollToIndexFailed={({ index }) => {
          // Off-screen rows need a layout pass before scrollToIndex works.
          setTimeout(() => {
            listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.35 });
          }, 120);
        }}
        ListEmptyComponent={
          roomActivity ? null : (
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
        renderItem={({ item, index }) => {
          // thread is newest-first; the chronologically older neighbor is at index+1.
          const previous = thread[index + 1];
          const showTime = !previous || previous.time !== item.time;
          const blocks: MessageBlock[] =
            item.blocks && item.blocks.length > 0 ? item.blocks : [{ kind: "text", markdown: item.body }];
          const nameColor = item.mine ? colors.text : colorFor(item.agentId ?? item.author);
          const author = item.agentId === agent.id ? agent : (members.find((member) => member.id === item.agentId) ?? null);
          const face = author ?? (item.agentId ? rosterFaces.get(item.agentId) ?? null : null);
          const highlighted = highlightId === item.id;
          const relay = item.relay;
          return (
            <View>
              {showTime ? <Text style={styles.time}>Today {item.time}</Text> : null}
              {relay ? (
                <View style={styles.relayWrap}>
                  <RelayBadge
                    kind={relay.kind}
                    author={item.author}
                    authorId={item.agentId}
                    peers={relay.peers}
                    roster={rosterFaces}
                    onPress={() => openRelaySheet(item)}
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
                  <SwipeableBubble
                    onSwipe={() => onReply(item)}
                    onActive={(active) => listRef.current?.setNativeProps({ scrollEnabled: !active })}
                  >
                    <Pressable
                      ref={(view) => {
                        if (view) bubbleViews.current.set(item.id, view);
                        else bubbleViews.current.delete(item.id);
                      }}
                      onLongPress={() => openMenu(item)}
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
                              onPress={() => scrollToReply(item.replyTo!)}
                              hitSlop={6}
                            >
                              <Text style={styles.quote}>↩ {item.replyPreview}</Text>
                            </Pressable>
                          ) : null
                        }
                        messageId={item.id}
                        onApprove={onApprove}
                        onDeny={onDeny}
                        onSubmitPoll={onPollSubmit}
                        onQuestionPick={onQuestionPick}
                        onSubmitSecret={onSecretSubmit}
                        onOpenDesktop={onDesktop}
                        onOpenAgent={onOpenAgent}
                        agentInfo={(id) => rosterFaces.get(id)}
                        fetchBlob={onFetchBlob}
                      />
                      <ReactionChips reactions={item.reactions ?? []} onPick={(emoji) => onReact(item, emoji)} />
                    </Pressable>
                  </SwipeableBubble>
                </View>
              </View>
              )}
            </View>
          );
        }}
      />
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
      <Modal
        visible={relaySheet !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setRelaySheet(null)}
      >
        <Pressable style={styles.relaySheetBackdrop} onPress={() => setRelaySheet(null)}>
          <Pressable style={[styles.relaySheet, { paddingBottom: Math.max(16, insets.bottom) }]} onPress={(event) => event.stopPropagation()}>
            <View style={styles.relaySheetHandle} />
            {relaySheet ? (
              <>
                <Text style={styles.relaySheetTitle}>
                  {relaySheet.relay?.kind === "to"
                    ? `Messaged ${relaySheet.relay.peers.map((peer) => peer.label).join(", ") || "the team"}`
                    : `Message from ${relaySheet.author}`}
                </Text>
                <ScrollView style={styles.relaySheetBody} bounces={false}>
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
                  {relaySheet.relay?.sourceConversationId && onLoadTeamChat ? (
                    <View style={styles.teamChat}>
                      <Text style={styles.teamChatTitle}>Where this came from · read only</Text>
                      {teamChat === null ? (
                        <Text style={styles.teamChatMuted}>Loading…</Text>
                      ) : teamChat.length === 0 ? (
                        <Text style={styles.teamChatMuted}>Nothing to show yet.</Text>
                      ) : (
                        teamChat.map((line) => (
                          <View key={line.id} style={styles.teamChatLine}>
                            <Text style={styles.teamChatAuthor}>
                              {line.author} <Text style={styles.teamChatMuted}>{line.time}</Text>
                            </Text>
                            <Text style={styles.teamChatBody}>{line.body}</Text>
                          </View>
                        ))
                      )}
                    </View>
                  ) : null}
                </ScrollView>
                <PillButton label="Close" onPress={() => setRelaySheet(null)} />
              </>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
      <MessageMenu
        frame={held?.frame ?? null}
        mine={held?.bubble.mine ?? false}
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
                  onPress: () => {
                    setHeld(null);
                    void copyText(messagePlainText(held.bubble.blocks, held.bubble.body));
                  },
                },
                {
                  label: "Select Text",
                  icon: <IconSelectText />,
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
      <View style={[styles.composer, { paddingBottom: Math.max(8, insets.bottom) }]}>
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
        <PillButton label="Send" onPress={onSend} disabled={!canSend} busy={sending} />
      </View>
    </View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
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
  swipeHint: { position: "absolute", right: 4, color: colors.link, fontSize: 22, fontWeight: "700" },
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
  relaySheetBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  relaySheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 16,
    paddingTop: 8,
    maxHeight: "70%",
    gap: 12,
  },
  relaySheetHandle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.line,
    marginBottom: 4,
  },
  relaySheetTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  relaySheetBody: { maxHeight: 460 },
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
