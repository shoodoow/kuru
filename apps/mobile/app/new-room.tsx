import { NewRoomSheet } from "../src/inbox/NewRoomSheet";
import { useSession } from "../src/session/SessionProvider";

export default function NewRoomRoute() {
  const session = useSession();
  return (
    <NewRoomSheet
      agents={session.agents}
      providers={session.providers}
      defaultModel={session.defaultModel}
      onCreateChat={(name, role, jobDescription, provider, modelId, agentKind) =>
        session.createChat(name, role, jobDescription, provider, modelId, agentKind)
      }
      onAskSupport={(agent) => session.openAgent(agent)}
      onCreateGroup={(title, agentIds) => session.createGroup(title, agentIds)}
    />
  );
}
