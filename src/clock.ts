// How times are written. Everything is local time: the app runs on the user's machine, so the
// server's clock and timezone are the user's.
import type { Window } from "./memory/temporal.ts";

const DAY: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", year: "numeric" };
/** "Tue 3 Nov 2026" */
export const formatDay = (ms: number) => new Date(ms).toLocaleDateString("en-GB", DAY).replace(",", "");
/** "Tue 3 Nov 2026, 10:42" */
export const formatWhen = (ms: number) => `${formatDay(ms)}, ${new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
/** "Tue 3 Nov 2026", or "Mon 2 Nov 2026 to Sun 8 Nov 2026" for a longer window. */
export function formatWindow(w: Window) {
  const last = new Date(w.end);
  last.setDate(last.getDate() - 1);
  const a = formatDay(w.start);
  const b = formatDay(last.getTime());
  return a === b ? a : `${a} to ${b}`;
}
/** "2026-11-03", the date format the search API takes. */
export const isoDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
