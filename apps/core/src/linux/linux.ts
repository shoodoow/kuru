import { config } from "../config.js";
import { finished } from "node:stream/promises";
import { PassThrough, type Duplex } from "node:stream";
import Dockerode from "dockerode";
import { and, eq } from "drizzle-orm";
import type { Store } from "../db/client.js";
import { sharedDb } from "../db/client.js";
import { agents, user } from "../db/schema.js";
import { logger } from "../log/logger.js";
import { ACCOUNT_NETWORK, applyFirewall, applyHostFirewall, ensureAccountNetwork } from "./firewall.js";
import { inGb, largestGrant, planMemory, type MemoryPlan } from "./memory-plan.js";

const image = "kuru-linux:1";
const GB = 1024 * 1024 * 1024;
const storageSize = "50G";
const toolchainRepairs = new Map<string, Promise<void>>();
const containerNameByAccount = new Map<string, string>();
const emailByAccount = new Map<string, string>();
/** Per container: the start the network rules were installed for, and when that was last confirmed. */
const firewalled = new Map<string, { startedAt: string; checkedAt: number }>();
const firewallRuns = new Map<string, Promise<void>>();
const FIREWALL_RECHECK_MS = 60_000;
/** When the host-side rules were last installed, and the install in flight. */
let hostRulesAt = 0;
let hostRulesRun: Promise<void> | null = null;

const docker = new Dockerode({
  socketPath: config.dockerSocket(),
});

export type ExecResult = { stdout: string; code: number; truncated: boolean };
export type ExecBytesResult = { stdout: Buffer; code: number; truncated: boolean };

export type ExecOptions = {
  /** Output past this many bytes is dropped and the command's stream is closed. */
  maxBytes?: number;
  /** Stops waiting, and closes the stream, after this long. */
  timeoutMs?: number;
};

/**
 * Most output one command may hand back to the core.
 * Why: output is held in the core's memory, and the core serves every
 * account. Without a ceiling one `yes` or one `cat` of a huge file inside a
 * container took the whole server down.
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Thrown when a command outlives the time its caller allowed. */
export class ExecTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The command did not finish within ${Math.round(timeoutMs / 1000)} seconds.`);
    this.name = "ExecTimeoutError";
  }
}

/** Docker demux can write after the hijack socket closes; swallow EPIPE so it never crashes core. */
function swallowBrokenPipe(stream: PassThrough): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
  });
}

/**
 * Reads a started exec to its end, within the caller's byte and time limits.
 * Input: the container, the exec, its attached stream, and the limits.
 * Output: the combined output, the exit code, and whether output was cut.
 * Reaching the byte limit closes the stream, which ends most commands with a
 * broken pipe; the exit code is then whatever Docker has recorded so far.
 */
async function collectExec(
  container: Dockerode.Container,
  running: Dockerode.Exec,
  stream: Duplex,
  options: ExecOptions = {},
): Promise<ExecBytesResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  swallowBrokenPipe(stdout);
  swallowBrokenPipe(stderr);
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  let timedOut = false;
  const keep = (chunk: Buffer): void => {
    if (truncated) return;
    const room = maxBytes - size;
    if (chunk.length > room) {
      if (room > 0) chunks.push(chunk.subarray(0, room));
      size = maxBytes;
      truncated = true;
      stream.destroy();
      return;
    }
    chunks.push(chunk);
    size += chunk.length;
  };
  stdout.on("data", keep);
  stderr.on("data", keep);
  stream.on("error", () => {
    // The read ends through the stream's close; without a listener the error would crash the process.
  });
  container.modem.demuxStream(stream, stdout, stderr);
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        stream.destroy();
      }, options.timeoutMs)
    : undefined;
  try {
    await finished(stream);
  } catch (error) {
    // Closing the stream ourselves is the expected way out of both limits.
    if (!truncated && !timedOut) throw error;
  } finally {
    if (timer) clearTimeout(timer);
    stdout.destroy();
    stderr.destroy();
  }
  if (timedOut) throw new ExecTimeoutError(options.timeoutMs ?? 0);
  const info = await running.inspect();
  return { stdout: Buffer.concat(chunks), code: info.ExitCode ?? (truncated ? 0 : 1), truncated };
}

/**
 * Returns the directory every agent on this account's Linux can use.
 * Input: the account id. The container already belongs to that account.
 * Output: /shared inside that account's Linux.
 */
export function accountShared(_accountId: string): string {
  return "/shared";
}

/**
 * Returns one agent's home on that account's Linux.
 * Input: the account id and the Linux username.
 * Output: the absolute home path. Another account's container does not have this home.
 */
export function accountHome(_accountId: string, profile: string): string {
  return `/home/${profile}`;
}

/**
 * Starts one Linux container for one account.
 * Why: exactly one container per account (name derived from the sign-in email;
 * tests without a user row keep nano-<accountId>). Test runs label their
 * containers nano.test=1 so cleanup can wipe test computers
 * without ever touching the developer's real account container on the same
 * Docker daemon. Concurrent first-use calls race safely: the loser of the
 * createContainer name race falls back to the winner's container instead of
 * 409ing the request.
 * Input: the account id.
 * Output: the container id. A second call returns the container that is already running.
 */
export async function createLinux(accountId: string, emailHint?: string): Promise<string> {
  await ensureImage();
  const name = await resolveContainerName(accountId, emailHint);
  const email = await accountEmail(accountId, emailHint);
  const labels: Record<string, string> = { "nano.account": accountId };
  if (email) {
    labels["nano.email"] = email;
  }
  if (config.isTest()) {
    labels["nano.test"] = "1";
  }
  const existing = docker.getContainer(name);
  try {
    const info = await existing.inspect();
    assertOwnContainer(accountId, email, name, info.Config?.Labels);
    if (!info.State.Running) {
      await existing.start();
    }
    await ensureFirewall(name, { now: true });
    await ensureLimits(existing, accountId, info.HostConfig ?? {});
    await ensureRestart(existing, info.HostConfig?.RestartPolicy?.Name);
    await ensureBaseToolchain(accountId);
    return info.Id;
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== 404) {
      throw error;
    }
  }
  try {
    if (config.containerFirewall() === "host") await ensureAccountNetwork(docker);
    const { plan, cpus, gpu } = await machinePlan();
    const hostConfig = accountContainerHostConfig(accountId, { memoryBytes: plan.baselineBytes, cpus, gpu });
    const make = (host: Dockerode.HostConfig) =>
      docker.createContainer({ name, Image: image, Labels: labels, HostConfig: host }).catch((error: unknown) => {
        // Docker can cap a container's disk only on some storage setups (xfs with
        // project quotas). On an ordinary Linux disk it refuses the option, and
        // no account could be created. The computer is made without the cap then.
        if (!/storage[- ]?opt|storage driver|pquota|quota/i.test(error instanceof Error ? error.message : "")) throw error;
        logger.warn({ accountId }, `This machine's Docker cannot limit a container's disk, so the ${storageSize} disk limit is not applied.`);
        const { StorageOpt: _dropped, ...withoutDiskLimit } = host;
        return docker.createContainer({ name, Image: image, Labels: labels, HostConfig: withoutDiskLimit });
      });
    let made: Dockerode.Container | undefined;
    try {
      made = await make(hostConfig);
      await made.start();
    } catch (error) {
      if (!gpu || (error as { statusCode?: number }).statusCode === 409) throw error;
      // Docker lists the graphics card but cannot hand it over (a driver that
      // is missing or broken). A computer without it is better than no computer.
      logger.warn({ accountId, error: error instanceof Error ? error.message : String(error) }, "The graphics card could not be given to this computer, so it is made without it.");
      await made?.remove({ force: true }).catch(() => undefined);
      const { DeviceRequests: _dropped, ...withoutGpu } = hostConfig;
      await (await make(withoutGpu)).start();
    }
    await ensureFirewall(name, { now: true });
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== 409) {
      throw error;
    }
    // Lost the name race with a concurrent first-use: adopt the winner.
    const winner = await docker.getContainer(name).inspect();
    assertOwnContainer(accountId, email, name, winner.Config?.Labels);
    if (!winner.State.Running) {
      await docker.getContainer(name).start();
    }
    await ensureFirewall(name, { now: true });
    return winner.Id;
  }
  await ensureBaseToolchain(accountId);
  const shared = await exec(accountId, ["sh", "-c", "mkdir -p /shared && chmod 1777 /shared"]);
  if (shared.code !== 0) {
    throw new Error(shared.stdout || "The shared directory was not created.");
  }
  return docker.getContainer(name).inspect().then((info) => info.Id);
}

/**
 * Closes a running account container's network to private addresses.
 * Why: a container on Docker's bridge can otherwise reach the machine the
 * core runs on (its database and API) and other accounts' containers.
 * With "netns" rules, they live in the container's network namespace and
 * are lost when it restarts, so they are tied to its start time. With
 * "host" rules, they live on the host for the shared account network, and
 * the container is moved onto that network. Either way the result is
 * confirmed again once a minute, or at once when the caller passes {now: true}.
 * Input: the container name. Output: nothing. Throws when the rules could
 * not be installed, so no command runs in an open container.
 */
async function ensureFirewall(name: string, options?: { now?: boolean }): Promise<void> {
  const mode = config.containerFirewall();
  if (mode === "off") return;
  const known = firewalled.get(name);
  if (known && !options?.now && Date.now() - known.checkedAt < FIREWALL_RECHECK_MS) return;
  const active = firewallRuns.get(name);
  if (active) return active;
  const labels: Record<string, string> = config.isTest() ? { "nano.test": "1" } : {};
  const run = (async () => {
    const info = await docker.getContainer(name).inspect();
    if (!info.State.Running) return;
    assertRuntime(name, info.HostConfig?.Runtime);
    const startedAt = info.State.StartedAt;
    if (mode === "host") {
      await ensureHostRules(labels, options?.now ?? false);
      await moveToAccountNetwork(name, Object.keys(info.NetworkSettings?.Networks ?? {}));
    }
    if (firewalled.get(name)?.startedAt !== startedAt) {
      if (mode === "netns") await applyFirewall(docker, image, name, labels);
      await removeLegacyTokens(name);
    }
    firewalled.set(name, { startedAt, checkedAt: Date.now() });
  })().finally(() => {
    if (firewallRuns.get(name) === run) firewallRuns.delete(name);
  });
  firewallRuns.set(name, run);
  return run;
}

/**
 * Refuses a container made with a different runtime than the one configured.
 * Why: a runtime cannot be changed on an existing container. Running an
 * old plain container after the operator asked for virtual machines would
 * quietly give less isolation than they believe they have.
 */
function assertRuntime(name: string, actual: string | undefined): void {
  const wanted = config.containerRuntime();
  if (!wanted || !actual || actual === wanted) return;
  throw new Error(
    `Container ${name} was created with the ${actual} runtime, but CONTAINER_RUNTIME is ${wanted}. Remove the container so it is created again, or unset CONTAINER_RUNTIME.`,
  );
}

/** Installs the host-side rules, at most once a minute unless asked for now. One install runs at a time. */
async function ensureHostRules(labels: Record<string, string>, now: boolean): Promise<void> {
  if (!now && Date.now() - hostRulesAt < FIREWALL_RECHECK_MS) return;
  if (hostRulesRun) return hostRulesRun;
  const run = (async () => {
    await ensureAccountNetwork(docker);
    await applyHostFirewall(docker, image, labels);
    hostRulesAt = Date.now();
  })().finally(() => {
    if (hostRulesRun === run) hostRulesRun = null;
  });
  hostRulesRun = run;
  return run;
}

/** Attaches a container to the account network and detaches it from every other one. */
async function moveToAccountNetwork(name: string, current: string[]): Promise<void> {
  if (!current.includes(ACCOUNT_NETWORK)) {
    await docker.getNetwork(ACCOUNT_NETWORK).connect({ Container: name });
  }
  for (const other of current) {
    if (other !== ACCOUNT_NETWORK) await docker.getNetwork(other).disconnect({ Container: name, Force: true });
  }
}

/**
 * Deletes plugin tokens that older versions wrote into the container.
 * Why: plugin calls are now made by the core, so nothing reads these files,
 * and a token left on disk is one an agent could still copy.
 */
async function removeLegacyTokens(name: string): Promise<void> {
  const container = docker.getContainer(name);
  const running = await container.exec({ Cmd: ["rm", "-rf", "/var/nano/mcp"], User: "root", AttachStdout: true, AttachStderr: true });
  const stream = await running.start({ hijack: true, stdin: false });
  const result = await collectExec(container, running, stream);
  if (result.code !== 0) {
    throw new Error(`Old plugin tokens could not be removed from ${name}. ${result.stdout.toString("utf8").trim()}`);
  }
}

/** The account's container, with its network rules confirmed. */
async function accountContainer(accountId: string): Promise<Dockerode.Container> {
  const name = await resolveContainerName(accountId);
  await ensureFirewall(name);
  return docker.getContainer(name);
}

/**
 * Runs a command in an account container.
 * Input: the account id, the command argv, an optional Linux user, environment entries, and limits.
 * Output: the combined stdout, the exit code, and whether the output was cut at the byte limit.
 */
export async function exec(
  accountId: string,
  command: string[],
  user = "root",
  env?: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  const result = await execBytes(accountId, command, user, env, options);
  return { stdout: result.stdout.toString("utf8"), code: result.code, truncated: result.truncated };
}

/**
 * Runs a command and keeps stdout as bytes.
 * Input: the account id, the command argv, an optional Linux user, and optional environment entries.
 * Output: the stdout bytes and the exit code.
 */
export async function execBytes(
  accountId: string,
  command: string[],
  user = "root",
  env?: string[],
  options?: ExecOptions,
): Promise<ExecBytesResult> {
  const container = await accountContainer(accountId);
  const running = await container.exec({
    Cmd: command,
    User: user,
    Env: env,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await running.start({ hijack: true, stdin: false });
  return collectExec(container, running, stream, options);
}

/**
 * Runs a command with bytes piped to its stdin, keeping stdout as bytes.
 * Why: multi-megabyte blobs (phone attachments) exceed ARG_MAX when passed as
 * argv, so base64-in-argv tricks fail past ~2MB. Streaming via stdin has no
 * such ceiling: one exec per file regardless of size.
 * Input: account id, command argv, stdin bytes, optional user/env.
 * Output: the stdout bytes and the exit code.
 */
/**
 * Runs a command and hands back its output as it is produced.
 * Why: a large file sent to the phone must not pass through the core's memory
 * the way `exec` output does. Input: account id, argv, the Linux user.
 * Output: the command's stdout as a stream, and `stop` to end it early.
 */
export async function execStream(
  accountId: string,
  command: string[],
  user = "root",
): Promise<{ output: PassThrough; stop: () => void }> {
  const container = await accountContainer(accountId);
  const running = await container.exec({ Cmd: command, User: user, AttachStdout: true, AttachStderr: true });
  const stream = await running.start({ hijack: true, stdin: false });
  const output = new PassThrough();
  const errors = new PassThrough();
  errors.resume();
  swallowBrokenPipe(output);
  swallowBrokenPipe(errors);
  stream.on("error", () => output.end());
  stream.on("end", () => output.end());
  stream.on("close", () => output.end());
  container.modem.demuxStream(stream, output, errors);
  return { output, stop: () => stream.destroy() };
}

export async function execStdin(
  accountId: string,
  command: string[],
  stdin: Buffer,
  user = "root",
  env?: string[],
  options?: ExecOptions,
): Promise<ExecBytesResult> {
  const container = await accountContainer(accountId);
  const running = await container.exec({
    Cmd: command,
    User: user,
    Env: env,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await running.start({ hijack: true, stdin: true });
  stream.write(stdin);
  stream.end();
  return collectExec(container, running, stream, options);
}

/**
 * Connects a socket to a command's stdin and stdout inside the account container.
 * Input: the account id, the command argv, and the caller's socket.
 * Output: nothing. Bytes flow both ways until either side closes.
 */
export async function pipeExec(accountId: string, command: string[], socket: Duplex, preamble?: Buffer): Promise<void> {
  const container = await accountContainer(accountId);
  const running = await container.exec({
    Cmd: command,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await running.start({ hijack: true, stdin: true });
  stream.on("error", () => socket.destroy());
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  swallowBrokenPipe(stdout);
  swallowBrokenPipe(stderr);
  stderr.resume();
  container.modem.demuxStream(stream, stdout, stderr);
  if (preamble) {
    stream.write(preamble);
  }
  stdout.on("error", () => socket.destroy());
  stdout.pipe(socket, { end: true });
  socket.on("error", () => {
    stream.destroy();
    stdout.destroy();
  });
  socket.on("data", (chunk: Buffer) => {
    if (!stream.writable) return;
    stream.write(chunk, (error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "EPIPE") {
        socket.destroy();
      }
    });
  });
  socket.on("close", () => stream.end());
  stream.on("end", () => socket.end());
}

/**
 * Creates the agent's user on the account Linux.
 * Why: the account container may be gone (Docker prune, test teardown wiping
 * all nano.* containers, or restart on a fresh host) while the account row
 * survives in Postgres. Ensuring the container first makes profile creation
 * self-healing: the next chat/conversation request recreates it instead of
 * 500ing with "No such container". createLinux is idempotent (returns or
 * starts the existing container), so the happy path costs one inspect.
 * Input: the database, the account id, and the agent id.
 * Output: the username. The home is mode 700 and is stored on the agent.
 */
export async function createProfile(store: Store, accountId: string, agentId: string): Promise<string> {
  const [agent] = await store
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
  if (!agent) {
    throw new Error("Agent not found.");
  }
  await createLinux(accountId);
  const username = agent.linuxProfile ?? `u${agentId.replaceAll("-", "").slice(0, 16)}`;
  await ensureProfile(accountId, username);
  if (!agent.linuxProfile) {
    await store
      .update(agents)
      .set({ linuxProfile: username })
      .where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
  }
  return username;
}

/**
 * Makes one agent profile ready for autonomous work inside its account container.
 * Why: shell-only jobs may run before a desktop is opened, so user creation and
 * container-local admin rights cannot depend on desktop boot. Re-running this
 * repairs profiles after a container recreation and is safe for existing users.
 * Input: account id and generated Linux username. Output: nothing; throws when
 * the profile or sudo policy cannot be established.
 */
async function ensureProfile(accountId: string, username: string): Promise<void> {
  const home = accountHome(accountId, username);
  const exists = await exec(accountId, ["id", "-u", username]);
  if (exists.code !== 0) {
    const added = await exec(accountId, ["useradd", "-m", "-d", home, "-s", "/bin/bash", username]);
    if (added.code !== 0) {
      throw new Error(added.stdout || "The Linux user was not created.");
    }
  }
  const locked = await exec(accountId, ["chmod", "700", home]);
  if (locked.code !== 0) {
    throw new Error(locked.stdout || "The home directory was not locked.");
  }
  const sudoers = await exec(accountId, [
    "sh",
    "-c",
    `printf '%s ALL=(ALL) NOPASSWD:ALL\\n' '${username}' > '/etc/sudoers.d/nano-${username}' && chmod 440 '/etc/sudoers.d/nano-${username}'`,
  ]);
  if (sudoers.code !== 0) {
    throw new Error(sudoers.stdout || "The Linux admin policy was not created.");
  }
}

/**
 * Removes account containers created by this process.
 * Why: test runs must never delete the developer's real account computer
 * sharing the same Docker daemon. Pass {testOnly:true} to remove solely
 * containers labeled nano.test=1 (set by createLinux under NODE_ENV=test).
 * Input: optional {testOnly} scope flag. Output: nothing.
 */
export async function removeAccountContainers(options?: { testOnly?: boolean }): Promise<void> {
  const labelFilter = options?.testOnly ? ["nano.account", "nano.test=1"] : ["nano.account"];
  const containers = await docker.listContainers({ all: true, filters: { label: labelFilter } });
  await Promise.all(
    containers.map(async (container) => {
      const accountId = container.Labels["nano.account"];
      await docker.getContainer(container.Id).remove({ force: true });
      if (accountId) {
        try {
          await docker.getVolume(`nano-account-${accountId}`).remove();
        } catch {
          // The volume was already removed with the container.
        }
      }
    }),
  );
}

/**
 * Removes one account's computer and its disk.
 * Why: used when the account itself is deleted, so nothing the agents made
 * outlives it. Found by the account label, not by name, since the name comes
 * from an email that may have changed.
 * Input: the account id. Output: nothing; a computer that never existed is fine.
 */
export async function removeAccountComputer(accountId: string): Promise<void> {
  const containers = await docker.listContainers({ all: true, filters: { label: [`nano.account=${accountId}`] } });
  for (const container of containers) {
    await docker.getContainer(container.Id).remove({ force: true });
  }
  try {
    await docker.getVolume(`nano-account-${accountId}`).remove();
  } catch {
    // There was no disk, or it went with the container.
  }
}

/**
 * Docker-safe container name for one account email.
 * Input: the person's sign-in email. Output: nano-<sanitized-email>.
 */
export function containerName(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const local = trimmed
    .replace(/@/g, "-at-")
    .replace(/\+/g, "-plus-")
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safe = local || "account";
  return `nano-${safe}`;
}

/**
 * Picks the container name for one account and remembers it.
 * Why: the readable name comes from the sign-in email, and two different
 * emails can clean up to the same name (`o'brien@` and `o-brien@`). A name
 * that already belongs to someone else is never reused: this account gets the
 * name built from its own id instead, so no one is attached to another
 * person's computer.
 * Input: account id and an optional email. Output: the container name.
 */
async function resolveContainerName(accountId: string, emailHint?: string): Promise<string> {
  const cached = containerNameByAccount.get(accountId);
  if (cached) {
    return cached;
  }
  const email = await accountEmail(accountId, emailHint);
  const fallback = `nano-${accountId}`;
  const preferred = email ? containerName(email) : fallback;
  const name = (await ownedByAnother(accountId, email, preferred)) ? fallback : preferred;
  containerNameByAccount.set(accountId, name);
  return name;
}

/** The sign-in email for one account, lowercased, or undefined when it has no user row. */
async function accountEmail(accountId: string, hint?: string): Promise<string | undefined> {
  const known = hint?.trim() || emailByAccount.get(accountId);
  if (known) {
    const clean = known.toLowerCase();
    emailByAccount.set(accountId, clean);
    return clean;
  }
  const [row] = await sharedDb()
    .select({ email: user.email })
    .from(user)
    .where(eq(user.accountId, accountId))
    .limit(1);
  const email = row?.email?.trim().toLowerCase();
  if (email) emailByAccount.set(accountId, email);
  return email || undefined;
}

/**
 * True when a container's labels name a different owner.
 * Why: the email label is the lasting identity. An account row can be made
 * again for the same person (a database reset), and their computer must come
 * back to them, so a matching email wins over a changed account id. Older
 * containers without an email label are matched on the account id.
 */
export function isForeignContainer(
  accountId: string,
  email: string | undefined,
  labels: Record<string, string> | undefined,
): boolean {
  const labelEmail = labels?.["nano.email"];
  if (labelEmail && email) return labelEmail !== email;
  const owner = labels?.["nano.account"];
  return Boolean(owner) && owner !== accountId;
}

/** True when a container with this name exists and belongs to someone else. */
async function ownedByAnother(accountId: string, email: string | undefined, name: string): Promise<boolean> {
  try {
    const info = await docker.getContainer(name).inspect();
    return isForeignContainer(accountId, email, info.Config?.Labels);
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return false;
    throw error;
  }
}

/**
 * Stops an account from using a container that belongs to someone else.
 * Why: last line of defence for two first-use calls that raced to the same
 * name. The cached name is dropped so the next call picks the id-based one.
 */
function assertOwnContainer(
  accountId: string,
  email: string | undefined,
  name: string,
  labels: Record<string, string> | undefined,
): void {
  if (isForeignContainer(accountId, email, labels)) {
    containerNameByAccount.delete(accountId);
    throw new Error(`Container ${name} belongs to another account. Retry to get this account's own computer.`);
  }
}

/**
 * Host settings for one account cage.
 * Why: the container must not see the Docker socket or another account's volume.
 * Input: account id. Output: Docker HostConfig. Privileged stays off.
 */
export function accountContainerHostConfig(
  accountId: string,
  limits: { memoryBytes: number; cpus: number; gpu?: boolean } = { memoryBytes: 2 * GB, cpus: 2 },
): Dockerode.HostConfig {
  const binds = [`nano-account-${accountId}:/var/nano`];
  if (binds.some((bind) => bind.includes("docker.sock") || bind.startsWith("/") && !bind.startsWith("nano-account-"))) {
    throw new Error("Account containers cannot mount the host.");
  }
  return {
    // The everyday limit. A heavy job borrows more for a while (requestMemory).
    Memory: limits.memoryBytes,
    MemorySwap: limits.memoryBytes,
    // Every core, at half the weight of the server and the database: an
    // account gets the whole machine when it is free, and the server stays
    // quick when several computers are busy at once.
    NanoCpus: limits.cpus * 1_000_000_000,
    CpuShares: ACCOUNT_CPU_SHARES,
    // If the machine itself runs out of memory, a computer's processes go first, not the server's.
    OomScoreAdj: 500,
    StorageOpt: { size: storageSize },
    Binds: binds,
    Privileged: false,
    // A small init process as the computer's first process. Without it nothing collects the programs
    // that exit after their parent (every closed browser leaves several), and they pile up as dead
    // entries for the life of the computer, counted against PidsLimit.
    Init: true,
    // Raw sockets would let one container answer for another's address on the shared bridge.
    CapDrop: ["NET_RAW"],
    PidsLimit: 8192,
    // The computer comes back when the machine restarts. Without this a
    // rebooted laptop left every agent without its computer until a new chat was opened.
    RestartPolicy: { Name: RESTART_POLICY },
    ...(config.containerRuntime() ? { Runtime: config.containerRuntime() } : {}),
    // Every NVIDIA card on the machine, for computing and for video encoding.
    // The cards are shared: nothing limits how much of one a single computer takes.
    ...(limits.gpu ? { DeviceRequests: [{ Driver: "nvidia", Count: -1, Capabilities: [["gpu", "compute", "utility", "video"]] }] } : {}),
    ...(config.containerFirewall() === "host" ? { NetworkMode: ACCOUNT_NETWORK, Dns: config.containerDns() } : {}),
  };
}

const RESTART_POLICY = "unless-stopped";

/** Gives a computer made by an older version the restart rule new ones start with. */
async function ensureRestart(container: Dockerode.Container, current?: string): Promise<void> {
  if (current === RESTART_POLICY) return;
  await container.update({ RestartPolicy: { Name: RESTART_POLICY } }).catch(() => undefined);
}

const ACCOUNT_CPU_SHARES = 512;
const DEFAULT_GRANT_MINUTES = 30;
const MAX_GRANT_MINUTES = 180;
/** How long a request waits for another account's job to finish before answering "busy". */
const GRANT_WAIT_MS = 45_000;
const GRANT_RETRY_MS = 60_000;

let machine: Promise<{ plan: MemoryPlan; cpus: number; gpu: boolean }> | null = null;

/** This machine's memory plan, core count and whether it has a graphics card to share, read from Docker once. */
export function machinePlan(): Promise<{ plan: MemoryPlan; cpus: number; gpu: boolean }> {
  machine ??= docker
    .info()
    .then((info: { MemTotal?: number; NCPU?: number; Runtimes?: Record<string, unknown> }) => ({
      plan: planMemory(Number(info.MemTotal) || 8 * GB, config.accountMemoryGb()),
      cpus: Number(info.NCPU) || 2,
      gpu: sharesGpu(config.accountGpu(), Object.keys(info.Runtimes ?? {}), config.containerRuntime()),
    }))
    .catch((error: unknown) => {
      machine = null;
      throw error;
    });
  return machine;
}

/**
 * Whether new computers are given the machine's NVIDIA graphics card.
 * Why: nobody should have to set this on a machine that has one. Docker
 * lists an "nvidia" runtime once the NVIDIA Container Toolkit is installed,
 * and that is the sign. A virtual-machine runtime such as Kata cannot take a
 * card this way, so it gets none unless the setting insists.
 * Input: the ACCOUNT_GPU setting, the runtimes Docker lists, and CONTAINER_RUNTIME.
 */
export function sharesGpu(setting: "on" | "off" | "auto", runtimes: string[], runtime?: string): boolean {
  if (setting !== "auto") return setting === "on";
  return runtimes.includes("nvidia") && (!runtime || runtime === "runc" || runtime === "nvidia");
}

/** The one job on this machine that has borrowed memory, if any. */
let grant: { accountId: string; bytes: number; until: number; timer: NodeJS.Timeout } | null = null;

export type MemoryAnswer = { granted: boolean; memoryGb: number; minutes?: number; note: string };

/** Memory a computer's processes hold now, without the file cache Linux gives back on demand. */
async function memoryInUse(container: Dockerode.Container): Promise<number> {
  // One reading, not the default pair a second apart that Docker takes to work out CPU use.
  const stats = (await container.stats({ stream: false, "one-shot": true })) as { memory_stats?: { usage?: number; stats?: { inactive_file?: number } } };
  return Math.max(0, (stats.memory_stats?.usage ?? 0) - (stats.memory_stats?.stats?.inactive_file ?? 0));
}

/** The accounts whose computer is running now. */
export async function runningAccountIds(): Promise<string[]> {
  const rows = await docker.listContainers({ filters: { label: ["nano.account"] } });
  // Test computers are left to their tests.
  return rows.filter((row) => !row.Labels["nano.test"] || config.isTest()).map((row) => row.Labels["nano.account"] ?? "").filter(Boolean);
}

/** What one computer's processes hold now and what it is allowed, in bytes. */
export async function accountMemoryUse(accountId: string): Promise<{ usedBytes: number; limitBytes: number }> {
  const container = await accountContainer(accountId);
  const [usedBytes, info] = await Promise.all([memoryInUse(container), container.inspect()]);
  return { usedBytes, limitBytes: info.HostConfig?.Memory ?? 0 };
}

/** Memory every other running computer holds between them, each counted as at least 256 MB. */
async function othersInUse(accountId: string): Promise<number> {
  const rows = (await docker.listContainers({ filters: { label: ["nano.account"] } })).filter((row) => row.Labels["nano.account"] !== accountId);
  const used = await Promise.all(rows.map((row) => memoryInUse(docker.getContainer(row.Id)).catch(() => 0)));
  return used.reduce((sum, bytes) => sum + Math.max(bytes, 256 * 1024 * 1024), 0);
}

/**
 * Sets a computer's memory limit, unless that would cut into memory in use.
 * Why: a limit dropped below what is in use makes Linux kill processes in
 * that computer at once. Output: true when the limit is now `target`.
 */
async function setMemoryLimit(container: Dockerode.Container, current: number, target: number, force = false): Promise<boolean> {
  if (current === target) return true;
  if (!force && target < current && (await memoryInUse(container).catch(() => 0)) > target * 0.85) return false;
  await container.update({ Memory: target, MemorySwap: target });
  return true;
}

/** Brings a computer made by an older version to today's memory and CPU rules. */
async function ensureLimits(container: Dockerode.Container, accountId: string, current: Dockerode.HostConfig): Promise<void> {
  const { plan, cpus } = await machinePlan();
  if (current.NanoCpus !== cpus * 1_000_000_000 || current.CpuShares !== ACCOUNT_CPU_SHARES) {
    await container.update({ NanoCpus: cpus * 1_000_000_000, CpuShares: ACCOUNT_CPU_SHARES }).catch(() => undefined);
  }
  // A job that borrowed memory keeps it until its grant ends.
  if (grant?.accountId === accountId) return;
  await setMemoryLimit(container, current.Memory ?? 0, plan.baselineBytes).catch(() => false);
}

/**
 * Puts every running computer back on its everyday limit.
 * Why: a grant lives in this process. If the server stopped while a job had
 * borrowed memory, that computer would keep the large limit for good.
 * Called once when the server starts.
 */
export async function settleAccountComputers(): Promise<void> {
  const running = await docker.listContainers({ filters: { label: ["nano.account"] } });
  for (const row of running) {
    const container = docker.getContainer(row.Id);
    const info = await container.inspect().catch(() => null);
    const accountId = row.Labels["nano.account"];
    if (info && accountId) await ensureLimits(container, accountId, info.HostConfig ?? {}).catch(() => undefined);
  }
}

/**
 * Lends one account's computer more memory for a heavy job.
 * Why: see memory-plan.ts. One job at a time on the machine; a second
 * request waits a little, then is told when to ask again.
 * Input: account id, the GB wanted, and for how many minutes.
 * Output: what was granted, in words the agent can act on.
 */
export async function requestMemory(
  accountId: string,
  wantGb: number,
  minutes = DEFAULT_GRANT_MINUTES,
  /** For tests: how long to wait for another account's job, and what the other computers are taken to use. */
  probe: { waitMs?: number; othersInUse?: number } = {},
): Promise<MemoryAnswer> {
  const { plan } = await machinePlan();
  const everyday = plan.baselineBytes;
  const wanted = Math.round(wantGb * GB);
  if (wanted <= everyday && grant?.accountId !== accountId) {
    return { granted: true, memoryGb: everyday / GB, note: `Your computer already has ${inGb(everyday)}. There is nothing to ask for.` };
  }
  const deadline = Date.now() + (probe.waitMs ?? GRANT_WAIT_MS);
  while (grant && grant.accountId !== accountId && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  if (grant && grant.accountId !== accountId) {
    const wait = Math.max(1, Math.ceil((grant.until - Date.now()) / 60_000));
    return {
      granted: false,
      memoryGb: everyday / GB,
      note: `Another account's job has this machine's spare memory for about ${wait} more minutes. You have ${inGb(everyday)} now. Either run the job with fewer threads so it fits, or do other work and ask again then.`,
    };
  }
  const bytes = Math.min(wanted, largestGrant(plan, probe.othersInUse ?? (await othersInUse(accountId))));
  if (bytes <= everyday) {
    return { granted: false, memoryGb: everyday / GB, note: `This machine has no memory to spare beyond your ${inGb(everyday)}. Run the job with fewer threads so it fits.` };
  }
  const length = Math.min(MAX_GRANT_MINUTES, Math.max(1, Math.round(minutes)));
  await (await accountContainer(accountId)).update({ Memory: bytes, MemorySwap: bytes });
  if (grant) clearTimeout(grant.timer);
  const timer = setTimeout(() => void endGrant(accountId, 0), length * 60_000);
  timer.unref();
  grant = { accountId, bytes, until: Date.now() + length * 60_000, timer };
  return {
    granted: true,
    memoryGb: Math.round((bytes / GB) * 10) / 10,
    minutes: length,
    note:
      (bytes < wanted ? `Only ${inGb(bytes)} is free on this machine, not the ${inGb(wanted)} you asked for; choose a thread count that fits. ` : "") +
      `Your computer has ${inGb(bytes)} for ${length} minutes. Release it with computer_memory (action "release") as soon as the job is done; other accounts wait for it.`,
  };
}

/** Gives borrowed memory back. Input: account id. Output: what happened, in words. */
export async function releaseMemory(accountId: string): Promise<MemoryAnswer> {
  const { plan } = await machinePlan();
  if (grant?.accountId !== accountId) {
    return { granted: false, memoryGb: plan.baselineBytes / GB, note: "Your computer has no borrowed memory to give back." };
  }
  const lowered = await endGrant(accountId, 0);
  return {
    granted: false,
    memoryGb: (lowered ? plan.baselineBytes : grant?.bytes ?? plan.baselineBytes) / GB,
    note: lowered
      ? `Given back. Your computer is at its everyday ${inGb(plan.baselineBytes)}.`
      : "Something on your computer still holds most of that memory, so the limit stays for now and is lowered when it lets go. Stop the job's processes if it is finished.",
  };
}

/**
 * Ends a grant: lowers the limit, or tries again in a minute while the memory is still in use.
 * After ten tries the limit is lowered anyway, so one stuck process cannot hold the machine's spare memory for ever.
 */
async function endGrant(accountId: string, attempt: number): Promise<boolean> {
  const held = grant;
  if (!held || held.accountId !== accountId) return true;
  clearTimeout(held.timer);
  try {
    const { plan } = await machinePlan();
    const lowered = await setMemoryLimit(await accountContainer(accountId), held.bytes, plan.baselineBytes, attempt >= 10);
    if (!lowered) {
      held.timer = setTimeout(() => void endGrant(accountId, attempt + 1), GRANT_RETRY_MS);
      held.timer.unref();
      held.until = Date.now() + GRANT_RETRY_MS;
      return false;
    }
  } catch {
    // The computer is gone or unreachable: nothing is holding the memory.
  }
  if (grant === held) grant = null;
  return true;
}

/** What a computer has now. Input: account id. Output: its limit and what is in use, in words. */
export async function memoryStatus(accountId: string): Promise<MemoryAnswer> {
  const { plan } = await machinePlan();
  const container = await accountContainer(accountId);
  const limit = (await container.inspect()).HostConfig?.Memory ?? plan.baselineBytes;
  const used = await memoryInUse(container).catch(() => 0);
  const others = await othersInUse(accountId);
  const held = grant?.accountId === accountId;
  return {
    granted: held,
    memoryGb: Math.round((limit / GB) * 10) / 10,
    note: `Your computer may use ${inGb(limit)} and is using ${inGb(used)}. ${
      held
        ? `That includes memory borrowed for about ${Math.max(1, Math.ceil(((grant?.until ?? 0) - Date.now()) / 60_000))} more minutes.`
        : grant
          ? "Another account's job has the machine's spare memory right now."
          : `A heavy job can ask for up to ${inGb(largestGrant(plan, others))}.`
    }`,
  };
}

/**
 * Repairs older account containers to the current autonomous-work baseline.
 * Why: account computers are durable and are not recreated when the image
 * changes; this idempotent check gives existing employees Node, Python, and
 * build tools without deleting their homes, browser sessions, or files.
 */
async function ensureBaseToolchain(accountId: string): Promise<void> {
  const active = toolchainRepairs.get(accountId);
  if (active) return active;
  const repair = repairBaseToolchain(accountId).finally(() => {
    if (toolchainRepairs.get(accountId) === repair) toolchainRepairs.delete(accountId);
  });
  toolchainRepairs.set(accountId, repair);
  return repair;
}

/**
 * Performs the actual toolchain probe/install behind the per-account
 * single-flight guard, preventing concurrent first-use apt/dpkg lock races.
 */
async function repairBaseToolchain(accountId: string): Promise<void> {
  const ready = await exec(accountId, [
    "sh",
    "-c",
    `command -v npm >/dev/null && command -v python3 >/dev/null && python3 -m pip --version >/dev/null 2>&1 && ${AGENT_BROWSER_IS_CURRENT} && ${NODE_IS_CURRENT}`,
  ]);
  if (ready.code === 0) return;
  const base = await exec(accountId, ["sh", "-c", "command -v python3 >/dev/null && python3 -m pip --version >/dev/null 2>&1 && command -v git >/dev/null && command -v curl >/dev/null"]);
  if (base.code !== 0) {
    const installed = await exec(accountId, [
      "sh",
      "-c",
      "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git build-essential curl ca-certificates python3 python3-pip python3-venv && rm -rf /var/lib/apt/lists/*",
    ]);
    if (installed.code !== 0) {
      throw new Error(installed.stdout || "The Linux Python toolchain was not installed.");
    }
  }
  // An older Node, or a missing browser tool, still leaves a computer that works for most things.
  // So a failed download is tried again later, not on every command.
  const hasNode = (await exec(accountId, ["sh", "-c", "command -v node >/dev/null && command -v npm >/dev/null"])).code === 0;
  if (hasNode && Date.now() - (upgradeTried.get(accountId) ?? 0) < UPGRADE_RETRY_MS) return;
  upgradeTried.set(accountId, Date.now());
  let complete = true;
  if ((await exec(accountId, ["sh", "-c", NODE_IS_CURRENT])).code !== 0) {
    const node = await exec(accountId, ["sh", "-c", INSTALL_NODE]);
    if (node.code !== 0) {
      if (!hasNode) throw new Error(node.stdout || "Node was not installed.");
      complete = false;
      logger.warn({ accountId, output: node.stdout.slice(-400) }, `Node ${NODE_MAJOR} could not be installed on this computer. It keeps its older Node and is tried again in an hour.`);
    }
  }
  // A computer made from an earlier image has no agent-browser, which every browser tool runs through.
  const browser = await exec(accountId, [
    "sh",
    "-c",
    `${AGENT_BROWSER_IS_CURRENT} || npm install -g agent-browser@${AGENT_BROWSER_VERSION} >/tmp/agent-browser-install.log 2>&1 || { tail -c 400 /tmp/agent-browser-install.log; exit 1; }`,
  ]);
  if (browser.code !== 0) {
    complete = false;
    logger.warn({ accountId, output: browser.stdout.slice(-400) }, "The browser tools could not be installed on this computer. It is tried again in an hour.");
  }
  if (complete) upgradeTried.delete(accountId);
}

/**
 * The agent-browser release every computer runs. Keep it the same as apps/core/linux/Dockerfile.
 * Why fixed: left open, npm chooses by the Node version and installed a release a year
 * older on Node 22, whose clicks missed on a scrolled page and whose waits took 25 seconds.
 */
const AGENT_BROWSER_VERSION = "0.38.1";
const AGENT_BROWSER_IS_CURRENT = `[ "$(agent-browser --version 2>/dev/null)" = "agent-browser ${AGENT_BROWSER_VERSION}" ]`;

/** The Node release line account computers run. Keep it the same as apps/core/linux/Dockerfile. */
const NODE_MAJOR = 22;
const UPGRADE_RETRY_MS = 60 * 60 * 1000;
const upgradeTried = new Map<string, number>();
const NODE_IS_CURRENT = `command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge ${NODE_MAJOR} ]`;
/**
 * Puts the newest Node of the release line into /usr/local, ahead of Debian's
 * own older package on the PATH. Why this way: a computer made from an earlier
 * image keeps its files for good, so it cannot get Node from a new image.
 * The download is checked against the checksum nodejs.org publishes beside it.
 */
const INSTALL_NODE = [
  "set -e",
  'case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "No Node build for $(uname -m)."; exit 1 ;; esac',
  `base=https://nodejs.org/dist/latest-v${NODE_MAJOR}.x`,
  'line="$(curl -fsSL --retry 2 --max-time 30 "$base/SHASUMS256.txt" | grep " node-v[0-9.]*-linux-$arch\\.tar\\.gz$")"',
  'sum="${line%% *}"; file="${line##* }"; name="${file%.tar.gz}"',
  '[ -n "$sum" ] && [ -n "$file" ]',
  'curl -fsSL --retry 2 --max-time 300 -o "/tmp/$file" "$base/$file"',
  'echo "$sum  /tmp/$file" | sha256sum -c - >/dev/null',
  // Only the programs and their libraries: the archive's README and licence do not belong in /usr/local.
  'tar -xzf "/tmp/$file" -C /usr/local --strip-components=1 --no-same-owner "$name/bin" "$name/lib" "$name/include"',
  'rm -f "/tmp/$file"',
  NODE_IS_CURRENT,
].join("\n");

async function ensureImage(): Promise<void> {
  try {
    await docker.getImage(image).inspect();
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 404) {
      throw new Error(`Linux image ${image} is missing. Build apps/core/linux/Dockerfile first.`);
    }
    throw error;
  }
}
