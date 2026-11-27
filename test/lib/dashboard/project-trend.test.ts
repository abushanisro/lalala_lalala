import { describe, expect, it } from "vitest";

import { projectTrend } from "@/lib/dashboard/project-trend";

// Local times throughout, as the chart counts by the viewer's own days and months.
const NOW = new Date(2026, 10, 28, 0, 46);
const on = (year: number, month: number, day: number, hour = 12) => ({ createdAt: new Date(year, month - 1, day, hour).toISOString() });
const total = (buckets: { projects: number }[]) => buckets.reduce((sum, b) => sum + b.projects, 0);
const at = (buckets: { label: string; projects: number }[], label: string) => buckets.find(b => b.label === label)?.projects;

describe("projectTrend", () => {
  it("counts by day over the last 30 days while every project is that recent", () => {
    const trend = projectTrend([on(2026, 11, 27), on(2026, 11, 27, 9), on(2026, 11, 1, 0)], NOW);
    expect(trend.period).toBe("Last 30 days");
    expect(trend.buckets).toHaveLength(30);
    expect(trend.buckets[0]?.label).toBe("30 Oct");
    expect(trend.buckets[29]?.label).toBe("28 Nov");
    expect(at(trend.buckets, "27 Nov")).toBe(2);
    expect(at(trend.buckets, "1 Nov")).toBe(1);
    expect(total(trend.buckets)).toBe(3);
  });

  it("counts by month over the last 12 months when a project is older than 30 days, so none is left off the chart", () => {
    // The workspace this was found in: five projects from May to August, looked at in late November.
    const projects = [on(2026, 5, 13), on(2026, 6, 15), on(2026, 6, 25), on(2026, 7, 14), on(2026, 8, 30)];
    const trend = projectTrend(projects, NOW);
    expect(trend.period).toBe("Last 12 months");
    expect(trend.buckets.map(b => b.label)).toEqual([
      "Dec 2025", "Jan 2026", "Feb 2026", "Mar 2026", "Apr 2026", "May 2026", "Jun 2026", "Jul 2026", "Aug 2026", "Sep 2026", "Oct 2026", "Nov 2026",
    ]);
    expect(trend.buckets.map(b => b.projects)).toEqual([0, 0, 0, 0, 0, 1, 2, 1, 1, 0, 0, 0]);
  });

  it("keeps a recent project on the monthly chart beside the older ones", () => {
    const trend = projectTrend([on(2026, 8, 30), on(2026, 11, 27)], NOW);
    expect(trend.period).toBe("Last 12 months");
    expect(at(trend.buckets, "Aug 2026")).toBe(1);
    expect(at(trend.buckets, "Nov 2026")).toBe(1);
  });

  it("starts at the earliest project when it is more than 12 months old", () => {
    const trend = projectTrend([on(2024, 3, 5), on(2026, 11, 2)], NOW);
    expect(trend.period).toBe("Since Mar 2024");
    expect(trend.buckets[0]).toEqual({ label: "Mar 2024", projects: 1 });
    expect(trend.buckets).toHaveLength(33);
    expect(trend.buckets[32]).toEqual({ label: "Nov 2026", projects: 1 });
  });

  it("puts the first of the 30 days on the chart and the day before it on the monthly one", () => {
    expect(projectTrend([on(2026, 10, 30, 0)], NOW).period).toBe("Last 30 days");
    expect(projectTrend([on(2026, 10, 29, 23)], NOW).period).toBe("Last 12 months");
  });

  it("is 30 empty days for no projects, and leaves out a project with no readable date", () => {
    const none = projectTrend([], NOW);
    expect(none.period).toBe("Last 30 days");
    expect(total(none.buckets)).toBe(0);
    const trend = projectTrend([{ createdAt: null }, { createdAt: "not a date" }, {}, on(2026, 11, 20)], NOW);
    expect(total(trend.buckets)).toBe(1);
  });
});
