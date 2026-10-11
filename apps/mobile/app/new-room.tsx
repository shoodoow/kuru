import { NewRoomSheet } from "../src/inbox/NewRoomSheet";
import { useSession } from "../src/session/SessionProvider";

export default function NewRoomRoute() {
  const session = useSession();
  return (
    <NewRoomSheet
      agents={session.agents}
      onCreateChat={(name, look) => session.createChat(name, look)}
      onAskSupport={(agent, name) => session.askForAgent(agent, name)}
      onCreateGroup={(title, agentIds) => session.createGroup(title, agentIds)}
    />
  );
}
