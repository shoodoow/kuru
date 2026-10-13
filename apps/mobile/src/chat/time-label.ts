/** A gap this long between two messages gets a time line of its own. */
const GAP_MS = 10 * 60 * 1000;

function dayOf(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Says whether a time line belongs above a message.
 * Why: a line used to appear for every new minute, which split one
 * conversation into many. It now marks a new day or a real pause.
 * Input: when this message and the one before it were sent (ISO).
 * Output: true when the line should show.
 */
export function startsTimeGroup(sentAt: string, previousAt: string | undefined): boolean {
  if (!previousAt) return true;
  const now = new Date(sentAt);
  const before = new Date(previousAt);
  if (Number.isNaN(now.getTime()) || Number.isNaN(before.getTime())) return true;
  return dayOf(now) !== dayOf(before) || now.getTime() - before.getTime() >= GAP_MS;
}

/**
 * The time line above a message: "Today 14:05", "Yesterday 09:30", or
 * "12 Oct 18:20" (with the year once it is not this one).
 * Why: every line used to read "Today", whatever day the message was sent.
 * Input: when it was sent (ISO), and the present moment. Output: the line.
 */
export function timeLabel(sentAt: string, now: Date = new Date()): string {
  const sent = new Date(sentAt);
  if (Number.isNaN(sent.getTime())) return "";
  const clock = `${String(sent.getHours()).padStart(2, "0")}:${String(sent.getMinutes()).padStart(2, "0")}`;
  const days = Math.round((dayOf(now) - dayOf(sent)) / 86_400_000);
  if (days === 0) return `Today ${clock}`;
  if (days === 1) return `Yesterday ${clock}`;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][sent.getMonth()];
  const year = sent.getFullYear() === now.getFullYear() ? "" : ` ${sent.getFullYear()}`;
  return `${sent.getDate()} ${month}${year} ${clock}`;
}
