import { describe, expect, it } from "vitest";
import { budgetWindow, firstOccurrenceOnOrAfter, nextOccurrence, previewOccurrences, parseInTimeZone, convertMinor, savingsBand, savingsRatePct, sipProjection, toLocalDate, toMinor } from "./index";

describe("money", () => {
  it("converts minor units across currency exponents", () => {
    expect(convertMinor(10000, "THB", "NPR", 3.9)).toBe(39000);
    expect(convertMinor(1000, "USD", "JPY", 150)).toBe(1500);
    expect(convertMinor(5, "THB", "THB", 99)).toBe(5);
    expect(() => convertMinor(1, "THB", "NPR", 0)).toThrow();
  });
  it("avoids float drift when converting major to minor", () => {
    expect(toMinor(19.99, "USD")).toBe(1999);
    expect(toMinor(0.1 + 0.2, "USD")).toBe(30);
  });
  it("matches v1 savings-rate bands", () => {
    expect(savingsRatePct(0, 10)).toBeNull();
    expect(savingsBand(savingsRatePct(100, 80))).toBe("healthy");
    expect(savingsBand(savingsRatePct(100, 90))).toBe("low");
    expect(savingsBand(savingsRatePct(100, 120))).toBe("overspending");
  });
  it("matches the v1 SIP annuity-due formula", () => {
    const r = sipProjection(1000, 12, 1);
    expect(r.totalInvested).toBe(12000);
    expect(r.maturityValue).toBeCloseTo(12809.33, 1);
    expect(sipProjection(1000, 0, 2).maturityValue).toBe(24000);
  });
  it("buckets by the user's timezone, not UTC", () => {
    const instant = new Date("2025-08-31T18:30:00Z");
    expect(toLocalDate(instant, "UTC")).toBe("2025-08-31");
    expect(toLocalDate(instant, "Asia/Bangkok")).toBe("2025-09-01");
  });
  it("parses naive timestamps as wall-clock time in the user's zone", () => {
    expect(parseInTimeZone("2025-08-26 13:05", "Asia/Bangkok")?.toISOString()).toBe("2025-08-26T06:05:00.000Z");
    expect(parseInTimeZone("2025-08-26", "UTC")?.toISOString()).toBe("2025-08-26T00:00:00.000Z");
    expect(parseInTimeZone("2025-08-26T13:05:00+09:00", "Asia/Bangkok")?.toISOString()).toBe("2025-08-26T04:05:00.000Z");
    expect(parseInTimeZone("2025-02-31", "UTC")).toBeNull();
    expect(parseInTimeZone("garbage", "UTC")).toBeNull();
    expect(parseInTimeZone("2025-08-26 00:30", "Asia/Kathmandu")?.toISOString()).toBe("2025-08-25T18:45:00.000Z");
  });
  it("clamps month-end recurrences without drifting off the anchor day", () => {
    expect(previewOccurrences("2025-01-31", "monthly", 1, 31, 4)).toEqual(["2025-01-31", "2025-02-28", "2025-03-31", "2025-04-30"]);
    expect(nextOccurrence("2024-02-29", "yearly", 1, 29)).toBe("2025-02-28");
    expect(nextOccurrence("2025-08-28", "weekly", 2, 28)).toBe("2025-09-11");
    expect(nextOccurrence("2025-12-31", "daily", 1, 31)).toBe("2026-01-01");
    expect(previewOccurrences("2025-01-15", "monthly", 1, 15, 10, "2025-03-15")).toHaveLength(3);
  });
  it("finds the first occurrence on or after a date", () => {
    expect(firstOccurrenceOnOrAfter("2025-01-10", "monthly", 1, "2025-03-11")).toBe("2025-04-10");
    expect(firstOccurrenceOnOrAfter("2025-01-10", "monthly", 1, "2025-03-10")).toBe("2025-03-10");
    expect(firstOccurrenceOnOrAfter("2030-01-01", "daily", 1, "2025-01-01")).toBe("2030-01-01");
  });
  it("computes budget windows (month, week with configurable start, custom)", () => {
    expect(budgetWindow("month", "2025-02-14", 1, "2025-01-01")).toEqual({ from: "2025-02-01", to: "2025-02-28" });
    expect(budgetWindow("month", "2024-12-31", 1, "2025-01-01")).toBeNull(); // before start
    expect(budgetWindow("month", "2025-03-01", 1, "2025-01-01", "2025-02-28")).toBeNull(); // ended
    expect(budgetWindow("week", "2025-08-27", 1, "2025-01-01")).toEqual({ from: "2025-08-25", to: "2025-08-31" }); // Mon-start
    expect(budgetWindow("week", "2025-08-27", 0, "2025-01-01")).toEqual({ from: "2025-08-24", to: "2025-08-30" }); // Sun-start
    expect(budgetWindow("custom", "2025-08-27", 1, "2025-08-01", "2025-08-31")).toEqual({ from: "2025-08-01", to: "2025-08-31" });
    expect(budgetWindow("custom", "2025-09-01", 1, "2025-08-01", "2025-08-31")).toBeNull();
  });
});
