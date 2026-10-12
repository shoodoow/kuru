/**
 * How this machine's memory is shared between the server and the accounts' computers.
 * Why: every computer used to be allowed 10 GB. Three of them on a 16 GB
 * laptop could ask for 30 GB, and when memory ran out Linux could kill the
 * server or the database. A fixed smaller share would not do either: a video
 * render needs 10 GB for a few minutes and almost nothing the rest of the day.
 * So a computer gets a small everyday limit, and one job at a time on the
 * machine may borrow most of what is left. The numbers come from the machine,
 * not from a setting someone has to get right.
 */

const GB = 1024 * 1024 * 1024;

export type MemoryPlan = {
  /** All the memory Docker has on this machine. */
  hostBytes: number;
  /** Kept back for the server, the database and the system. */
  reserveBytes: number;
  /** What the accounts' computers may use between them. */
  poolBytes: number;
  /** A computer's everyday limit. */
  baselineBytes: number;
};

/**
 * Works out the plan for one machine.
 * Input: the machine's memory in bytes, and an optional everyday limit in GB
 * (the ACCOUNT_MEMORY_GB setting). Output: the plan, in whole megabytes.
 */
export function planMemory(hostBytes: number, everydayGb?: number): MemoryPlan {
  const reserveBytes = Math.min(4 * GB, hostBytes * 0.3);
  const poolBytes = Math.max(GB, hostBytes - reserveBytes);
  // A quarter of the pool suits three or four people; never tiny, never wasteful.
  const share = Math.min(8 * GB, Math.max(2 * GB, poolBytes / 4));
  const baselineBytes = Math.min(poolBytes, everydayGb && everydayGb > 0 ? everydayGb * GB : share);
  return { hostBytes, reserveBytes: megabytes(reserveBytes), poolBytes: megabytes(poolBytes), baselineBytes: megabytes(baselineBytes) };
}

/**
 * The most one job may borrow right now.
 * Input: the plan and the memory the other computers are using at this
 * moment. What they use is counted, not what they are allowed: an idle
 * desktop holds a few hundred megabytes, and it is rare for everyone to be
 * busy at once. Output: bytes, never below the everyday limit.
 */
export function largestGrant(plan: MemoryPlan, othersInUseBytes: number): number {
  return Math.max(plan.baselineBytes, megabytes(plan.poolBytes - othersInUseBytes));
}

/** Bytes as a short figure for a person or an agent: "10 GB", "2.5 GB". */
export function inGb(bytes: number): string {
  return `${Math.round((bytes / GB) * 10) / 10} GB`;
}

function megabytes(bytes: number): number {
  return Math.floor(bytes / (1024 * 1024)) * 1024 * 1024;
}
