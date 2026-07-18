import type { JobDateValue } from "../../contracts/src/index.js";

export const JOB_RETENTION_MONTHS = 6;
export const UNKNOWN_PUBLICATION_GRACE_DAYS = 7;
export const JOB_FRESHNESS_TIME_ZONE = "Asia/Tokyo";

export type PublicationFreshness = "recent" | "unknown_quarantine" | "expired";
export type PublicationDecisionReason =
  | "published_within_retention_window"
  | "published_older_than_retention_window"
  | "published_in_future"
  | "publication_date_unknown"
  | "publication_date_unknown_after_grace";

export interface PublicationDecision {
  freshness: PublicationFreshness;
  reason: PublicationDecisionReason;
  publicationDate: string | null;
  cutoffDate: string;
  quarantineUntil: string | null;
}

export type PublicationLookbackReason =
  | "published_within_lookback_window"
  | "published_before_lookback_window"
  | "published_in_future"
  | "publication_date_unknown";

export interface PublicationLookbackDecision {
  eligible: boolean;
  reason: PublicationLookbackReason;
  publicationDate: string | null;
  cutoffDate: string;
  today: string;
}

export function evaluatePublicationFreshness(
  published: JobDateValue | undefined,
  firstSeenAt: Date,
  now = new Date(),
): PublicationDecision {
  const today = tokyoCalendarDate(now);
  const cutoffDate = subtractCalendarMonths(today, JOB_RETENTION_MONTHS);
  if (published === undefined) {
    const quarantineUntil = new Date(firstSeenAt.getTime() + UNKNOWN_PUBLICATION_GRACE_DAYS * 86_400_000).toISOString();
    if (now.getTime() >= Date.parse(quarantineUntil)) {
      return {
        freshness: "expired",
        reason: "publication_date_unknown_after_grace",
        publicationDate: null,
        cutoffDate,
        quarantineUntil: null,
      };
    }
    return {
      freshness: "unknown_quarantine",
      reason: "publication_date_unknown",
      publicationDate: null,
      cutoffDate,
      quarantineUntil,
    };
  }
  const publicationDate = published.precision === "date"
    ? normalizeDateOnly(published.value)
    : tokyoCalendarDate(new Date(published.value));
  if (publicationDate > today) {
    return { freshness: "expired", reason: "published_in_future", publicationDate, cutoffDate, quarantineUntil: null };
  }
  if (publicationDate < cutoffDate) {
    return {
      freshness: "expired",
      reason: "published_older_than_retention_window",
      publicationDate,
      cutoffDate,
      quarantineUntil: null,
    };
  }
  return {
    freshness: "recent",
    reason: "published_within_retention_window",
    publicationDate,
    cutoffDate,
    quarantineUntil: null,
  };
}

export function parsePublishedDateValue(input: string): JobDateValue | undefined {
  const raw = input.trim();
  if (raw === "") return undefined;
  const normalized = raw
    .replace(/^(?:datePosted|datePublished|publishedAt|published_at|releasedDate|postedAt|posted_at|publishDate|publishedDate|first_published)\s*:\s*/i, "")
    .replace(/^(?:掲載日|公開日|投稿日|掲載開始日|募集開始日)\s*[：:]?\s*/, "")
    .trim();
  const dateMatch = /^(\d{4})\s*(?:年|[./-])\s*(\d{1,2})\s*(?:月|[./-])\s*(\d{1,2})\s*日?$/.exec(normalized);
  if (dateMatch?.[1] !== undefined && dateMatch[2] !== undefined && dateMatch[3] !== undefined) {
    const value = `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`;
    return validDateOnly(value) ? { value, precision: "date" } : undefined;
  }
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? { value: new Date(timestamp).toISOString(), precision: "datetime" } : undefined;
}

export function evaluatePublicationLookback(
  published: JobDateValue | undefined,
  lookbackDays: number,
  now = new Date(),
): PublicationLookbackDecision {
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1) {
    throw new Error("lookbackDays must be a positive integer");
  }
  const today = tokyoCalendarDate(now);
  const cutoffDate = subtractCalendarDays(today, lookbackDays);
  if (published === undefined) {
    return { eligible: false, reason: "publication_date_unknown", publicationDate: null, cutoffDate, today };
  }
  const publicationDate = published.precision === "date"
    ? normalizeDateOnly(published.value)
    : tokyoCalendarDate(new Date(published.value));
  if (publicationDate > today) {
    return { eligible: false, reason: "published_in_future", publicationDate, cutoffDate, today };
  }
  if (publicationDate < cutoffDate) {
    return { eligible: false, reason: "published_before_lookback_window", publicationDate, cutoffDate, today };
  }
  return { eligible: true, reason: "published_within_lookback_window", publicationDate, cutoffDate, today };
}

export function tokyoCalendarDate(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("Invalid date");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: JOB_FRESHNESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year === undefined || month === undefined || day === undefined) throw new Error("Could not format Tokyo date");
  return `${year}-${month}-${day}`;
}

export function subtractCalendarMonths(date: string, months: number): string {
  if (!Number.isInteger(months) || months < 0) throw new Error("months must be a non-negative integer");
  return shiftCalendarMonths(date, -months);
}

export function subtractCalendarDays(date: string, days: number): string {
  if (!Number.isInteger(days) || days < 0) throw new Error("days must be a non-negative integer");
  const normalized = normalizeDateOnly(date);
  const timestamp = Date.parse(`${normalized}T00:00:00.000Z`) - days * 86_400_000;
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function addCalendarMonths(date: string, months: number): string {
  if (!Number.isInteger(months) || months < 0) throw new Error("months must be a non-negative integer");
  return shiftCalendarMonths(date, months);
}

function shiftCalendarMonths(date: string, months: number): string {
  const normalized = normalizeDateOnly(date);
  const [yearValue, monthValue, dayValue] = normalized.split("-").map(Number);
  if (yearValue === undefined || monthValue === undefined || dayValue === undefined) throw new Error("Invalid date");
  const absoluteMonth = yearValue * 12 + monthValue - 1 + months;
  const year = Math.floor(absoluteMonth / 12);
  const month = absoluteMonth - year * 12 + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(Math.min(dayValue, lastDay)).padStart(2, "0")}`;
}

function normalizeDateOnly(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !validDateOnly(value)) throw new Error(`Invalid date-only value: ${value}`);
  return value;
}

function validDateOnly(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
