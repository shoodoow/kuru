import { useEffect, useLayoutEffect, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { createCore } from "../../src/api";
import { ChatScreen } from "../../src/chat/ChatScreen";
import { useSession } from "../../src/session/SessionProvider";
import { Avatar } from "../../src/ui/Avatar";
import { IconMonitor } from "../../src/ui/icons";
import { colors } from "../../src/theme/tokens";
import { Toast } from "../../src/ui/Toast";

export default function ChatRoute() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const navigation = useNavigation();
  const session = useSession();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const chat = session.lastChat?.conversationId === conversationId ? session.lastChat : null;
  // The footer line shows the turn the phone is watching, or failing that any
  // work the server says is running here (a background job, a scheduled run).
  const busyHere = session.inbox?.rooms.find((room) => room.id === conversationId)?.working ?? false;
  const activity = session.roomActivity ?? (busyHere ? ("working" as const) : null);
  const activityRef = useRef(activity);
  activityRef.current = activity;
  const leaveRef = useRef(session.leaveChat);
  leaveRef.current = session.leaveChat;
  const core = useRef(createCore());

  useEffect(() => {
    return () => {
      if (conversationId) leaveRef.current(conversationId);
    };
  }, [conversationId]);

  useLayoutEffect(() => {
    if (!chat) return;
    navigation.setOptions({
      headerTitle: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={chat.kind === "group" ? `Group details for ${chat.title}` : `Agent details for ${chat.title}`}
          onPress={() => {
            const current = sessionRef.current;
            if (!chat) return;
            if (chat.kind === "group") void current.openGroupInfo().catch(current.show);
            else current.openProfile(chat.agent);
          }}
          style={{ flexDirection: "row", alignItems: "center", gap: 8, maxWidth: 220 }}
        >
          <Avatar
            id={chat.agent.id}
            size={26}
            round
            shape={chat.agent.markShape}
            color={chat.agent.markColor}
            material={chat.agent.markMaterial}
            style={chat.agent.markStyle}
            gender={chat.agent.markGender}
            photo={chat.agent.avatarUrl}
            mood={activityRef.current ? "working" : "idle"}
          />
          <View style={{ flexShrink: 1 }}>
            <Text style={{ color: colors.text, fontSize: 16, fontWeight: "600" }} numberOfLines={1}>
              {chat.title}
            </Text>
            {chat.subtitle ? (
              <Text style={{ color: colors.muted, fontSize: 12 }} numberOfLines={1}>
                {chat.subtitle}
              </Text>
            ) : null}
          </View>
        </Pressable>
      ),
      headerRight: () =>
        chat.kind === "direct" && chat.agent.linuxProfile ? (
          <Pressable
            accessibilityLabel="Desktop"
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => sessionRef.current.openDesktop(chat.agent)}
            style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}
          >
            <IconMonitor />
          </Pressable>
        ) : null,
    });
  }, [chat, navigation, activity]);

  if (!chat) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}>
        <Text style={{ color: colors.muted }}>Opening chat…</Text>
      </View>
    );
  }

  return (
    <>
    <ChatScreen
      agent={chat.agent}
      conversationId={chat.conversationId}
      title={chat.title}
      subtitle={chat.subtitle}
      contextRing={session.contextRing}
      members={chat.kind === "group" ? session.agents.filter((row) => chat.memberIds.includes(row.id)) : []}
      roster={session.agents}
      messages={session.messages}
      draft={session.draft}
      sending={session.sending}
      roomActivity={activity}
      isGroup={chat.kind === "group"}
      error={session.note}
      replyTo={session.replyTo}
      attachments={session.attachments}
      onDraft={session.setDraft}
      onSend={() => void session.send(chat.conversationId).catch(session.show).finally(() => session.setSending(false))}
      onPickImage={() => void session.pickImage().catch(session.show)}
      onPickCamera={() => void session.pickCamera().catch(session.show)}
      onPickFile={() => void session.pickFile().catch(session.show)}
      onRemoveAttachment={(id) => session.setAttachments((current) => current.filter((attachment) => attachment.id !== id))}
      onReply={session.setReplyTo}
      onClearReply={() => session.setReplyTo(null)}
      onPollSubmit={(text) => void session.sendText(chat.conversationId, text).catch(session.show)}
      onQuestionPick={(messageId, pick) => void session.answerQuestion(chat.conversationId, messageId, pick).catch(session.show)}
      onSecretSubmit={(name, secret) => session.saveVaultSecret(name, secret)}
      onLoadTeamChat={session.loadTeamChat}
      onLoadOlder={() => void session.loadOlderMessages().catch(session.show)}
      onReact={(bubble, emoji) => void session.toggleReaction(chat.conversationId, bubble, emoji).catch(session.show)}
      onApprove={(approvalId) => {
        if (approvalId) void session.decideToolRow(approvalId, true).catch(session.show);
        else void session.refreshProposals().catch(session.show);
      }}
      onDeny={(approvalId) => {
        if (approvalId) void session.decideToolRow(approvalId, false).catch(session.show);
        else void session.refreshProposals().catch(session.show);
      }}
      onFetchBlob={(messageId, index) => core.current.blob(session.accountId.trim(), chat.conversationId, messageId, index)}
      onBack={() => {}}
      onDesktop={() => session.openDesktop(chat.agent)}
      onAgentMenu={() => {
        if (chat.kind === "group") void session.openGroupInfo().catch(session.show);
        else session.openProfile(chat.agent);
      }}
      onOpenAgent={(agentId) => {
        const target = session.agents.find((row) => row.id === agentId);
        if (target) void session.openAgent(target).catch(session.show);
      }}
    />
    {/* Errors already print above the composer. */}
    <Toast tones={["success"]} />
    </>
  );
}
