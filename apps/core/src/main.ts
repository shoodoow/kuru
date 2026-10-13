import { config } from "./config.js";
import { sharedDb } from "./db/client.js";
import { ensureGatewayModelsLoaded, registerGatewayModelInfoProvider } from "./model/gateway-models.js";
import { startServer } from "./http/server.js";
import { startHousekeeping } from "./computer/housekeeping.js";
import { settleAccountComputers } from "./linux/linux.js";
import { resolveSkillsDir } from "./skills/paths.js";
import { startScheduler } from "./routines/scheduler.js";
import { ensureWorkerLifecycle } from "./turn/orchestrator.js";
import { recoverInterruptedWorkers } from "./turn/handlers/worker-recovery.js";

const skillsDir = resolveSkillsDir(config.skillsDir());
if (skillsDir) {
  process.env.SKILLS_DIR = skillsDir;
}

// Fails here, before anything listens, when the secret is missing or too short.
config.authSecret();

registerGatewayModelInfoProvider();
void ensureGatewayModelsLoaded();
const db = sharedDb();
const server = await startServer(db, config.port());
// Unattended loop: due routines fire, crashed runs heal, pings relay, old
// resume events prune. Chat queued during a live turn starts when it ends.
const stopScheduler = startScheduler(db, { skillsRoot: config.skillsDir() });
// Workers that were mid-job when the process stopped: recent ones carry on
// from their saved conversation, old ones are closed so nothing reads as
// "running" with no one working on it.
ensureWorkerLifecycle(db);
// A job that had borrowed memory when the process stopped: its computer goes back to the everyday limit.
void settleAccountComputers().catch(() => undefined);
// Browsers nobody has used for an hour are closed, so a computer's memory is not held by idle windows.
const stopHousekeeping = startHousekeeping(db);
void recoverInterruptedWorkers(db, config.skillsDir()).catch((error: unknown) => {
  console.error("Interrupted workers were not recovered:", error);
});

/** How long open requests get to finish before their connections are closed. */
const SHUTDOWN_GRACE_MS = config.isProduction() ? 5_000 : 500;
let stopping = false;

/**
 * Stops the core in order: no new ticks, no new requests, then the database.
 * Why: a deploy or restart used to cut the process mid-request and leave
 * connections open on Postgres until they timed out.
 */
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down.`);
  stopScheduler();
  stopHousekeeping();
  const force = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
  force.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearTimeout(force);
  await db.$client.end({ timeout: 5 });
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => void shutdown(signal));
}
