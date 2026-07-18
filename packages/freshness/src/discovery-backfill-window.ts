import type { JobDiscoveryLead } from "../../contracts/src/index.js";
import {
  evaluatePublicationLookback,
  subtractCalendarDays,
  tokyoCalendarDate,
  type PublicationLookbackDecision,
} from "./job-freshness.js";

export interface DiscoveryBackfillWindow {
  days: number;
  cutoffDate: string;
  today: string;
  evaluatedAt: Date;
}

export function discoveryBackfillWindow(rawDays: string | undefined, now = new Date()): DiscoveryBackfillWindow | null {
  if (rawDays === undefined || rawDays.trim() === "") return null;
  const days = Number(rawDays);
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error(`DISCOVERY_BACKFILL_DAYS must be an integer from 1 to 366, received ${rawDays}`);
  }
  const today = tokyoCalendarDate(now);
  return { days, today, cutoffDate: subtractCalendarDays(today, days), evaluatedAt: now };
}

export function evaluateLeadForBackfill(
  lead: Pick<JobDiscoveryLead, "published">,
  window: DiscoveryBackfillWindow | null,
): PublicationLookbackDecision | null {
  return window === null ? null : evaluatePublicationLookback(lead.published, window.days, window.evaluatedAt);
}
