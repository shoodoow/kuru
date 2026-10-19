import { router, useLocalSearchParams } from "expo-router";
import { Text, View } from "react-native";
import { createCore } from "../../src/api";
import { BotInfoScreen } from "../../src/chat/BotInfoScreen";
import { useSession } from "../../src/session/SessionProvider";
import { colors } from "../../src/theme/tokens";
import { Toast } from "../../src/ui/Toast";

const core = createCore();

export default function ProfileRoute() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const session = useSession();
  const profile = session.profile?.id === agentId ? session.profile : session.agents.find((row) => row.id === agentId) ?? null;

  if (!profile) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}>
        <Text style={{ color: colors.muted }}>Opening profile…</Text>
      </View>
    );
  }

  return (
    <>
    <BotInfoScreen
      profile={profile}
      providers={session.providers}
      routines={session.routines}
      onChange={(next) => session.setProfile(next)}
      onSave={() => session.saveProfile().catch(session.show)}
      onSaveNotify={(draft) => void session.saveProfile(draft).catch(session.show)}
      onBack={() => router.back()}
      onApprovals={() => void session.refreshProposals().catch(session.show)}
      onPickAvatar={() => void session.pickAvatar().catch(session.show)}
      onPauseRoutine={(routine, paused) => void session.pauseRoutine(routine, paused).catch(session.show)}
      onLoadRoutineRuns={(routineId) => core.listRoutineRuns(session.accountId.trim(), profile.id, routineId)}
      messages={session.profileFeed}
      onFetchBlob={(roomId, messageId, index) => core.blob(session.accountId.trim(), roomId, messageId, index)}
      health={{
        load: () => core.agentHealth(session.accountId.trim(), profile.id),
        fix: () => core.reflectNow(session.accountId.trim(), profile.id),
        undo: (reflectionId) => core.undoReflection(session.accountId.trim(), profile.id, reflectionId),
      }}
      work={{
        running: () => core.agentRunning(session.accountId.trim(), profile.id),
        stop: (workerId) => core.stopAgentJob(session.accountId.trim(), profile.id, workerId),
        memories: () => core.agentMemories(session.accountId.trim(), profile.id),
        forget: (memoryId) => core.forgetMemory(session.accountId.trim(), profile.id, memoryId),
      }}
    />
    <Toast />
    </>
  );
}
