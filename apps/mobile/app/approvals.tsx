import { createCore } from "../src/api";
import { ApprovalsScreen } from "../src/approvals/ApprovalsScreen";
import { useSession } from "../src/session/SessionProvider";

const core = createCore();

export default function ApprovalsRoute() {
  const session = useSession();
  return (
    <ApprovalsScreen
      proposals={session.proposals}
      toolApprovals={session.toolApprovals}
      onApprove={(id) => void session.refreshProposals(id, true).catch(session.show)}
      onReject={(id) => void session.refreshProposals(id, false).catch(session.show)}
      onApproveTool={(id, always) => void session.decideToolRow(id, true, always).catch(session.show)}
      onLoadAllowances={() => core.listAllowances(session.accountId.trim())}
      onRemoveAllowance={(id) => core.removeAllowance(session.accountId.trim(), id)}
      onDenyTool={(id) => void session.decideToolRow(id, false).catch(session.show)}
      onBack={() => {}}
    />
  );
}
