# Turn engine

Dispatcher-first room turns: the chatting agent answers, does a few quick lookups, and hands heavy work to background workers. Every prompt and tool description lives in the repo's `prompts/` folder (see `prompts/README.md`).

## Layout

| Path | Role |
|------|------|
| `orchestrator.ts` | `runTurn`, run ledger, speaker queue |
| `speaker.ts` | One agent: context → model loop → mentions |
| `agent-loop.ts` | Wires registry + trace harness |
| `tools/registry.ts` | Builds dispatcher tool map (+ MCP/plugins) |
| `tools/build-tools.ts` | Filters `@kuru/agent-tools` by surface |
| `tools/executors.ts` | Dispatcher tool side effects (DB writes) |
| `events/emitter.ts` | Durable `events` + SSE fanout |
| `events/bus.ts` | In-process worker/handoff events |
| `trace/` | Plugin-ready execution traces |
| `loop-control.ts` | When a turn ends, and the reply-only last step |
| `work-log.ts` | Saves each run's tool calls and replays them next turn |
| `tools/tool-sets.ts` | Optional tool sets (`team`, `routines`, `admin`) and `enable_tools` |
| `parent-wake.ts` | Private worker-result cue for manager review |
| `handlers/worker-lifecycle.ts` | Batches `worker.settled` and wakes the parent |

## Extend

- **New tool:** one row in `packages/agent-tools/src/definitions.ts`, its description as a `# name` section in `prompts/tools.md`, and the execute in `executors.ts` or `linux-tool-executes.ts`.
- **Measure a change:** `npx tsx scripts/trace-report.mts <conversationId>` (from `apps/core`) prints steps, tokens, failed and repeated tool calls per run.
- **New trace sink:** `registerTracePlugin()` in `trace/plugins.ts`.
- **Skills & plugin tools:** see [GUIDE.md](./GUIDE.md).
- **Persistence map:** see [DB-TRACE.md](./DB-TRACE.md).
