# Turn engine — how it works

## End-to-end flow

```text
POST /messages
  → runs (claim slot)
  → messages (user row)
  → runTurn (orchestrator)
       → speakOnce (per @mentioned agent)
            → buildContext (system + identity + optional skill names in prefix; room + summary + thread in tail)
            → runAgentLoop
                 → buildToolSet("dispatcher")  — built-in tools only today
                 → runModelHarness (AI SDK generateText + trace plugins)
                      → tool execute → DB (messages, delegations, …) + TurnEmitter → events + SSE
       → spawn_worker → runWorker (background)
            → worker tools (bash, web, read_skill, …)
            → delegations.result (report to parent)
            → TurnBus worker.settled → private parent wake
            → parent reviews and decides what the room sees
  → runs (done) + events (run done)
```

**Dispatcher** (chat agent): voice tools (`send_message`, …), team tools, `spawn_worker`. No direct bash/web/desktop on the dispatcher loop (workers do that).

**Worker**: computer tools + `read_history` / `read_skill`. No `send_message`.

**Persistence:** see [DB-TRACE.md](./DB-TRACE.md).

---

## Skills (procedures)

Skills are **markdown playbooks** on disk. The model sees **names + descriptions** in the cached prompt prefix; full steps load only when it calls `read_skill`.

### Layout

Set `SKILLS_DIR` to a directory (e.g. repo root `skills/`):

```text
skills/
  my-skill/
    SKILL.md          # default skill, every account gets it
```

`SKILLS_DIR` holds only these defaults. A skill that belongs to one account is kept on that account's computer:

```text
/shared/skills/<name>/SKILL.md             # all agents on the account: plugin skills, approved skills, published installs
/home/<agent>/.agents/skills/<name>/       # one agent's own installs (`npx skills add -g`)
```

A skill on the computer overrides a default of the same name. An older version wrote account skills to `skills/accounts/<account-uuid>/`; that folder is moved onto the computer the first time the account's skills are read.

Each `SKILL.md` must start with YAML frontmatter:

```yaml
---
name: my-skill
description: One line for the catalog in the system prompt.
---
```

Body = instructions the agent follows after `read_skill`.

### Runtime

| Step | What happens |
|------|----------------|
| Turn start | `skillCatalogForAgent({ skillsRoot, accountId, linuxProfile })` → names in prompt prefix (shared + `~/.agents/skills`) |
| Agent calls `read_skill({ name: "my-skill" })` | `readSkillForAgent` returns body (container-local wins, then host) |
| Worker | Same `read_skill` / `list_skills` with the worker's Linux profile |

Core passes `process.env.SKILLS_DIR` from [`server.ts`](../../http/server.ts) into `runTurn`.

**Sample:** [`../../../../skills/sample-greeting/SKILL.md`](../../../../skills/sample-greeting/SKILL.md) in this repo.

---

## Plugin tools (MCP catalog)

**Today:** plugin tools are registered in-process and merged into the **AI SDK tool map** via [`buildFullToolSet`](./tools/registry.ts). Names are `{server}_{tool}` (e.g. `crm_search`) so collisions are avoided. They are not duplicated in the text prompt.

**Account MCP (preferred):** HTTP connectors per account in `mcp_servers`; API under `/accounts/:id/mcp`. Tools merge in [`buildFullToolSet`](./tools/registry.ts) via [`mcp/tools.ts`](../mcp/tools.ts). See [`plugins/README.md`](../../../../plugins/README.md).

**In-process (optional):** [`registerPluginTool`](./plugins/registry.ts) for global code-only tools — not account-scoped.

### Adding a built-in tool (fully working)

1. [`packages/agent-tools/src/definitions.ts`](../../../../packages/agent-tools/src/definitions.ts) — one row (`name`, `surfaces`, `inputSchema` Zod); the description goes in `prompts/tools.md` as a `# name` section
2. [`tools/executors.ts`](./tools/executors.ts) — dispatcher handler in `dispatcherExecutors` (or Linux execute in [`linux-tool-executes.ts`](../computer/linux-tool-executes.ts) for `surfaces: ["worker"]`, `requiresLinux: true`)

---

## Trace plugins (execution inspect — works today)

Unlike MCP plugin *tools*, **trace plugins** hook every model step and tool call (DeepSeek-style harness).

```ts
import { registerTracePlugin } from "../turn/index.js";

registerTracePlugin({
  name: "my-inspect",
  async onEvent(ctx, event) {
    if (event.type === "tool.call.finish") {
      console.log(ctx.runId, event.name, event.durationMs, event.outputPreview);
    }
  },
});
```

Register before the first `runTurn` (e.g. in `main.ts` after imports). Default **jsonl** sink writes to `apps/core/.tool-trace.log`. Plugins must not throw (failures are isolated with `allSettled`).

Event types: `run.start`, `model.step.finish`, `tool.call.start`, `tool.call.finish`, `run.finish`, `run.error` — see [`trace/types.ts`](./trace/types.ts).

---

## Quick reference

| Goal | Mechanism |
|------|-----------|
| Talk to user | Final plain text is the reply; `send_message` for an early ack or rich blocks (see `prompts/system.md`) |
| Long work | `spawn_worker` with detailed `task` brief |
| Procedure | Skill folder + `read_skill` |
| Extra tool **execution** | `buildFullToolSet` (built-in catalog + MCP + in-process plugins) |
| Debug a turn | `.tool-trace.log` or custom `registerTracePlugin` |
