// Pure slot computation: no database access, so it is easy to test.
// Given working hours, time off and existing bookings, returns the start
// times a service can be booked on a local calendar date.
import { zonedToUtc, weekdayOf } from '../lib/time.ts';

export interface Interval { start: number; end: number } // epoch ms, [start, end)

export interface StaffSchedule {
  staffId: string;
  // Working intervals for the weekday of the requested date, minutes from local midnight
  hours: { start_min: number; end_min: number }[];
  busy: Interval[]; // bookings (start..blocked_until) and time off
}

export interface SlotQuery {
  date: string; // YYYY-MM-DD, local to tz
  tz: string;
  durationMin: number;
  bufferMin: number;
  slotIntervalMin: number;
  now: Date;
  minLeadMin: number;
  maxAdvanceDays: number;
}

export interface Slot { start: Date; staffIds: string[] }

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function computeSlots(q: SlotQuery, staff: StaffSchedule[]): Slot[] {
  const earliest = q.now.getTime() + q.minLeadMin * 60_000;
  const latest = q.now.getTime() + q.maxAdvanceDays * 86_400_000;
  const durMs = q.durationMin * 60_000;
  const blockMs = (q.durationMin + q.bufferMin) * 60_000;
  const byStart = new Map<number, string[]>();

  for (const s of staff) {
    const busy = [...s.busy].sort((a, b) => a.start - b.start);
    for (const h of s.hours) {
      // Step through the shift; the service must finish before the shift
      // ends, the clean-up buffer may run past it.
      for (let m = h.start_min; m + q.durationMin <= h.end_min; m += q.slotIntervalMin) {
        const start = zonedToUtc(q.date, m, q.tz).getTime();
        if (start < earliest || start > latest) continue;
        // Skip wall-clock times that don't exist (spring-forward gap).
        const end = zonedToUtc(q.date, m + q.durationMin, q.tz).getTime();
        if (end - start !== durMs) continue;
        const block: Interval = { start, end: start + blockMs };
        if (busy.some((b) => overlaps(block, b))) continue;
        const list = byStart.get(start);
        if (list) list.push(s.staffId); else byStart.set(start, [s.staffId]);
      }
    }
  }

  return [...byStart.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, staffIds]) => ({ start: new Date(start), staffIds }));
}

/** UTC bounds of a local calendar day, padded so overnight busy ranges are caught. */
export function dayBounds(date: string, tz: string): Interval {
  return { start: zonedToUtc(date, 0, tz).getTime(), end: zonedToUtc(date, 24 * 60, tz).getTime() };
}

export { weekdayOf };
