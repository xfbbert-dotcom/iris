import { describe, expect, it } from "vitest";

import { resolveHistoricalChatQuery } from "../src/memory/historical-chat-query.js";

const NOW = new Date("2026-09-08T04:30:00.000Z");

describe("resolveHistoricalChatQuery", () => {
  it.each([
    ["昨天聊了什么", "2026-09-06T16:00:00.000Z", "2026-09-07T16:00:00.000Z"],
    ["昨日聊了什么", "2026-09-06T16:00:00.000Z", "2026-09-07T16:00:00.000Z"],
    ["前天聊了什么", "2026-09-05T16:00:00.000Z", "2026-09-06T16:00:00.000Z"],
    ["今天聊了什么", "2026-09-07T16:00:00.000Z", "2026-09-08T16:00:00.000Z"],
    ["今日聊了什么", "2026-09-07T16:00:00.000Z", "2026-09-08T16:00:00.000Z"],
  ])("resolves the China calendar day named by %s", (question, start, end) => {
    expect(resolveHistoricalChatQuery(question, NOW)).toEqual({
      start: new Date(start),
      end: new Date(end),
      terms: [],
    });
  });

  it.each([
    ["2026-09-07 的发布会", "2026-09-06T16:00:00.000Z", "2026-09-07T16:00:00.000Z"],
    ["2026年9月7日的发布会", "2026-09-06T16:00:00.000Z", "2026-09-07T16:00:00.000Z"],
    ["9月7日的发布会", "2026-09-06T16:00:00.000Z", "2026-09-07T16:00:00.000Z"],
    ["2024-02-29 的发布会", "2024-02-28T16:00:00.000Z", "2024-02-29T16:00:00.000Z"],
  ])("resolves an explicit valid date in %s", (question, start, end) => {
    const query = resolveHistoricalChatQuery(question, NOW);

    expect(query?.start).toEqual(new Date(start));
    expect(query?.end).toEqual(new Date(end));
    expect(query?.terms).toContain("发布");
  });

  it.each([
    "2026-02-29 的发布会",
    "2026-04-31 的发布会",
    "2026-13-01 的发布会",
    "2月29日的发布会",
    "2026-09-09 的发布会",
  ])("rejects the invalid or future date in %s", (question) => {
    expect(resolveHistoricalChatQuery(question, NOW)).toBeUndefined();
  });

  it.each([
    "昨天和前天聊了什么",
    "昨天 2026-09-07 聊了什么",
    "2026-09-06 和 2026年9月7日聊了什么",
  ])("rejects multiple date references in %s instead of guessing", (question) => {
    expect(resolveHistoricalChatQuery(question, NOW)).toBeUndefined();
  });

  it("returns undefined when the question or reference time cannot identify a date", () => {
    expect(resolveHistoricalChatQuery("上次聊了什么", NOW)).toBeUndefined();
    expect(resolveHistoricalChatQuery("   ", NOW)).toBeUndefined();
    expect(resolveHistoricalChatQuery(undefined, NOW)).toBeUndefined();
    expect(resolveHistoricalChatQuery("昨天聊了什么", new Date(Number.NaN))).toBeUndefined();
  });

  it("keeps the concrete topic while removing date, question, and meta wording", () => {
    expect(resolveHistoricalChatQuery("昨天发的问卷主要讲了什么？", NOW)).toEqual({
      start: new Date("2026-09-06T16:00:00.000Z"),
      end: new Date("2026-09-07T16:00:00.000Z"),
      terms: ["问卷"],
    });
  });

  it("bounds meaningful topic terms without returning sentence particles", () => {
    const query = resolveHistoricalChatQuery(
      "昨天 alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november 的么",
      NOW,
    );

    expect(query?.terms).toHaveLength(12);
    expect(query?.terms).toEqual([
      "alpha", "bravo", "charlie", "delta", "echo", "foxtrot",
      "golf", "hotel", "india", "juliet", "kilo", "lima",
    ]);
    expect(query?.terms.every((term) => term.length >= 2)).toBe(true);
  });
});
