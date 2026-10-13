# Prompts

Every instruction a model reads lives in this folder. Edit a file and the next turn uses it; no restart is needed.

| File | What it holds | Loaded by |
|------|---------------|-----------|
| `system.md` | The standing prompt for a work agent (the default kind). The agent's identity block is appended after it. | `apps/core/src/prompt/build-instructions.ts` |
| `about.md` | What an agent knows about itself: that it is a Kuru agent, what the person has in the app, and the "what you can do" list. A line of that list is shown only while its tool exists. | `apps/core/src/prompt/capabilities.ts` |
| `companion.md` | The standing prompt for an agent kept for conversation (kind `companion`), used in place of `system.md`. | `apps/core/src/prompt/build-instructions.ts` |
| `support.md` | The account's default agent (kind `support`): its standing prompt, and the role, personality and job it is created with. | `apps/core/src/prompt/build-instructions.ts`, `apps/core/src/roster/roster.ts` |
| `dispatcher.md` | Short texts the chat agent's loop injects: the turn rule, the reply-now and ack notes, the stall nudge, the work-log note, the delegated-task line. | `apps/core/src/turn/` , `memory/context.ts` |
| `tools.md` | The description of every tool, one section per tool. `name.worker` sections are the worker's variant. | `turn/tools/build-tools.ts` |
| `tool-sets.md` | Guidance for the tool sets (`team`, `routines`, `admin`, and `support` for the default agent), shown when a set is on or when `enable_tools` turns it on. | `turn/tools/tool-sets.ts` |
| `cues.md` | Hidden notes that wake the agent: worker results and failures, a routine firing, an approval decision, a reaction, the default agent's first message. | `roster/roster.ts`, `turn/parent-wake.ts`, `rooms/subagents.ts`, `routines/routines.ts`, `turn/auto-review.ts`, `http/server.ts` |
| `workers/<kind>.md` | The standing method for each kind of background worker. | `rooms/worker-kinds.ts` |
| `worker-rules.md` | Rules added to every worker prompt (how to work, early exit, checking the result, report size), the notes the loop hands a running worker (a note from the agent, a nudge to stop reading and start, a continuation), the custom-worker wrapper, and the context lines attached to a brief. | `rooms/worker-kinds.ts`, `rooms/subagents.ts`, `turn/tools/executors.ts` |
| `memory.md` | The background passes that build long-term memory: folding old chat into summaries and facts, month/year roll-ups, the pinned profile. | `apps/core/src/memory/` |

## Format

Apart from `system.md` and `workers/*.md` (one prompt per file), a file holds several prompts. Each starts at a level-1 heading, `# key`, and runs to the next one. Text before the first heading is a note for people and is never sent to a model. Inside a prompt use `##` or lower for headings.

`{{name}}` is a placeholder the code fills in. The loader (`apps/core/src/prompt/prompts.ts`) throws if a key is missing or a placeholder has no value, so a typo fails loudly instead of sending a broken prompt.

## What is not here

Error messages returned by tools (for example "Path is outside the home and /shared") stay next to the code that produces them, because they describe what that code just did. Tool names and input schemas are in `packages/agent-tools/src/`.
