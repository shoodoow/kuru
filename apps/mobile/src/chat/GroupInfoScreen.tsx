import { useLayoutEffect, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "expo-router";
import type { MessageBlock, RosterAgent } from "../api";
import { darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { Avatar } from "../ui/Avatar";
import { useNavBarPad } from "../ui/nav-bar-pad";
import { GroupCluster } from "../ui/GroupCluster";
import { IconChevron } from "../ui/icons";
import { openFileBlock } from "./blocks";
import { MarkdownText } from "./MarkdownText";
import { collectShares, type SharedFile } from "./shares";

const MEMBER_LIMIT = 20;
type Tab = "info" | "links" | "media" | "files";

/**
 * Shows the group, its members, and what was shared in the room.
 * Why: the name badge belongs to the group, and member rows open that person's chat.
 */
export function GroupInfoScreen({
  title,
  brief,
  members,
  messages,
  onOpenMember,
  onFetchBlob,
}: {
  title: string;
  /** The team's shared brief, written by the lead agent. */
  brief?: string | null;
  members: RosterAgent[];
  messages: { conversationId?: string; body: string; blocks?: MessageBlock[] | null }[];
  onBack: () => void;
  onOpenMember: (member: RosterAgent) => void;
  onFetchBlob?: (conversationId: string, messageId: string, index: number) => Promise<{ url?: string; previewUrl?: string }>;
}) {
  const [tab, setTab] = useState<Tab>("info");
  const shares = collectShares(messages);
  const navigation = useNavigation();
  const navBarPad = useNavBarPad();
  useLayoutEffect(() => {
    navigation.setOptions({ title: title || "Group" });
  }, [navigation, title]);
  return (
    <View style={[styles.screen, navBarPad]}>
      <ScrollView contentContainerStyle={styles.page} contentInsetAdjustmentBehavior="automatic" showsVerticalScrollIndicator={false}>
        <View style={styles.cluster}>
          <GroupCluster members={members} size={52} />
        </View>
        <View style={styles.nameCard}>
          <Text style={styles.name}>{title}</Text>
        </View>
        <View style={styles.tabs}>
          {(["info", "links", "media", "files"] as const).map((entry) => (
            <Pressable key={entry} accessibilityRole="tab" accessibilityState={{ selected: tab === entry }} onPress={() => setTab(entry)} style={styles.tab}>
              <Text style={[styles.tabText, tab === entry ? styles.tabOn : null]}>{entry[0]?.toUpperCase()}{entry.slice(1)}</Text>
              {tab === entry ? <View style={styles.tabBar} /> : null}
            </Pressable>
          ))}
        </View>
        {tab === "links" ? <Rows title="No links yet" hint="Links shared with you will appear here." items={shares.links} onOpen={(href) => void Linking.openURL(href)} /> : null}
        {tab === "media" ? <Rows title="No media yet" hint="Photos shared with you will appear here." items={shares.media.map((item) => item.label)} /> : null}
        {tab === "files" ? (
          <Rows
            title="No files yet"
            hint="Files shared with you will appear here."
            items={shares.files.map((file) => file.name)}
            onOpenIndex={(index) => {
              const file = shares.files[index];
              if (!file) return;
              const fetchBlob = file.conversationId && onFetchBlob
                ? (messageId: string, blockIndex: number) => onFetchBlob(file.conversationId!, messageId, blockIndex)
                : undefined;
              void openFileBlock(toFileBlock(file), fetchBlob);
            }}
          />
        ) : null}
        {tab === "info" ? (
          <View style={styles.body}>
            <Text style={styles.sectionLabel}>Team brief</Text>
            <View style={[styles.card, styles.briefCard]}>
              {brief ? (
                <MarkdownText text={brief} links={false} />
              ) : (
                <Text style={styles.briefEmpty}>
                  No brief yet. Ask the lead to write one: the goal, who does what, and how work moves between teammates.
                </Text>
              )}
            </View>
            <Text style={styles.sectionLabel}>Members</Text>
            <View style={styles.card}>
              {members.map((member) => (
                <Pressable key={member.id} accessibilityRole="button" onPress={() => onOpenMember(member)} style={styles.member}>
                  <Avatar
                    id={member.id}
                    size={28}
                    shape={member.markShape}
                    color={member.markColor}
                    material={member.markMaterial}
                    style={member.markStyle}
                    gender={member.markGender}
                    photo={member.avatarUrl}
                  />
                  <Text style={styles.memberName} numberOfLines={1}>{member.label || member.name}</Text>
                  <IconChevron />
                </Pressable>
              ))}
            </View>
            <Text style={styles.caption}>Group chats can have up to {MEMBER_LIMIT} members.</Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function toFileBlock(file: SharedFile): Extract<MessageBlock, { kind: "file" }> {
  return { kind: "file", name: file.name, url: file.url, mime: file.mime, blobRef: file.blobRef };
}

function Rows({
  title,
  hint,
  items,
  onOpen,
  onOpenIndex,
}: {
  title: string;
  hint: string;
  items: string[];
  onOpen?: (item: string) => void;
  onOpenIndex?: (index: number) => void;
}) {
  if (items.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>{title}</Text>
        <Text style={styles.emptyHint}>{hint}</Text>
      </View>
    );
  }
  return (
    <View style={styles.body}>
      <View style={styles.card}>
        {items.map((item, index) => (
          <Pressable
            key={`${item}-${index}`}
            accessibilityRole="button"
            onPress={() => (onOpenIndex ? onOpenIndex(index) : onOpen?.(item))}
            style={styles.member}
          >
            <Text style={styles.memberName} numberOfLines={2}>{item}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 12, paddingTop: 4 },
  page: { paddingTop: 12, paddingBottom: 32 },
  cluster: { alignItems: "center", marginTop: 8 },
  sectionLabel: { color: colors.muted, fontSize: 13, fontWeight: "600", marginLeft: 4, marginBottom: 6, marginTop: 4 },
  briefCard: { paddingHorizontal: 14, paddingVertical: 12, marginBottom: 14 },
  briefText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  briefEmpty: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  // A badge that hugs the name, not a full-width card.
  nameCard: {
    alignSelf: "center",
    maxWidth: "80%",
    marginTop: 10,
    paddingHorizontal: 18,
    backgroundColor: colors.bubble,
    borderRadius: 999,
  },
  name: { color: colors.text, fontSize: 17, fontWeight: "600", textAlign: "center", paddingVertical: 8 },
  tabs: { flexDirection: "row", marginTop: 14, marginHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  tab: { flex: 1, alignItems: "center", paddingVertical: 8 },
  tabText: { color: colors.muted, fontSize: 15, fontWeight: "500" },
  tabOn: { color: colors.text },
  tabBar: { position: "absolute", bottom: 0, width: 36, height: 2, borderRadius: 1, backgroundColor: colors.text },
  body: { paddingHorizontal: 16, paddingTop: 12 },
  card: { backgroundColor: colors.bubble, borderRadius: 14, borderCurve: "continuous", overflow: "hidden" },
  member: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  memberName: { color: colors.text, fontSize: 16, flex: 1 },
  caption: { color: colors.muted, fontSize: 13, marginTop: 8 },
  empty: { alignItems: "center", paddingTop: 40, paddingHorizontal: 28, gap: 6 },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  emptyHint: { color: colors.muted, fontSize: 13, textAlign: "center" },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
