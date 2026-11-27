/**
 * How many projects were created in each day or month, over a period that holds every project given.
 *
 * A fixed "last 30 days" is an empty chart for a workspace whose projects are older, so the period follows the projects: the last
 * 30 days by day while every project is that recent, otherwise by month from the earliest project (never fewer than 12 months).
 * Days and months are the viewer's own, in local time.
 *
 * Pure: no API calls.
 */

export interface TrendBucket { label: string; projects: number }

export interface ProjectTrend {
  /** Oldest first, the current day or month last. */
  buckets: TrendBucket[];
  /** The period in words: "Last 30 days", "Last 12 months", "Since Mar 2024". */
  period: string;
}

const DAYS = 30;
const MONTHS = 12;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A month as one number, so months can be counted across years. */
const monthOf = (d: Date) => d.getFullYear() * 12 + d.getMonth();
const monthLabel = (month: number) => `${MONTH_NAMES[month % 12] ?? ""} ${Math.floor(month / 12)}`;

function tally<K>(dates: readonly Date[], key: (d: Date) => K): Map<K, number> {
  const counts = new Map<K, number>();
  for (const d of dates) counts.set(key(d), (counts.get(key(d)) ?? 0) + 1);
  return counts;
}

export function projectTrend(projects: readonly { createdAt?: string | null }[], now: Date = new Date()): ProjectTrend {
  const created = projects.flatMap(p => {
    const d = new Date(p.createdAt ?? "");
    return Number.isNaN(d.getTime()) ? [] : [d];
  });
  const firstDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (DAYS - 1));

  if (created.every(d => d >= firstDay)) {
    const perDay = tally(created, d => d.toDateString());
    const buckets = Array.from({ length: DAYS }, (_, i) => {
      const day = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() + i);
      return { label: `${day.getDate()} ${MONTH_NAMES[day.getMonth()] ?? ""}`, projects: perDay.get(day.toDateString()) ?? 0 };
    });
    return { buckets, period: `Last ${DAYS} days` };
  }

  const perMonth = tally(created, monthOf);
  const last = monthOf(now);
  const first = Math.min(last - (MONTHS - 1), ...created.map(monthOf));
  const buckets = Array.from({ length: last - first + 1 }, (_, i) => ({ label: monthLabel(first + i), projects: perMonth.get(first + i) ?? 0 }));
  return { buckets, period: first === last - (MONTHS - 1) ? `Last ${MONTHS} months` : `Since ${monthLabel(first)}` };
}
