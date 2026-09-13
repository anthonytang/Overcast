import type { DayEvent, ForecastResult } from "./forecast";
import { computeCascade } from "./cascade";
import type { WhatIfChange } from "./whatif";

/**
 * Spending Insights: CAUSAL, not descriptive. This never asks "where did
 * your money go" (a category pie chart); it answers "why do I go under on
 * this specific day," ranked by real contribution to the real shortfall.
 *
 * Every insight is derived directly from the real forecast's danger window
 * (the same window `computeCascade` already found): nothing here is a
 * separate/invented notion of "spending." An expense only ever appears if
 * it's the transaction that crosses the balance below zero, one that ate
 * into the cushion before that happened, or one that lands while the
 * account is already underwater and deepens it. A subscription that posts
 * after the account has already recovered is NOT included: it isn't
 * responsible for this overdraft, whatever else might be true about it.
 */

export type InsightRole = "trigger" | "erosion" | "deepens";
export type InsightCategory = "fixed" | "discretionary";

export interface SpendingInsight {
  id: string;
  streamName: string;
  amount: number;
  date: string;
  dayOffset: number;
  role: InsightRole;
  category: InsightCategory;
  headline: string;
  detail: string;
  actionable: boolean;
  whatIfChange: WhatIfChange | null;
}

/**
 * The forecast engine (mirroring the real Plaid recurring-transactions API)
 * doesn't carry a spending category: in production that would come from
 * Plaid's own categorization. For this fixed demo scenario, rent and
 * utilities are true fixed obligations; groceries and subscriptions are
 * flexible/discretionary spend. This mapping is a defensible stand-in for
 * that lookup, not a guess about any individual transaction.
 */
const FIXED_STREAM_NAMES = new Set(["SUNNYSIDE RENT", "CITY ELECTRIC"]);

function classify(name: string): InsightCategory {
  return FIXED_STREAM_NAMES.has(name) ? "fixed" : "discretionary";
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function formatMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function formatDateLabel(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[m - 1]} ${d}`;
}

export function computeSpendingInsights(data: ForecastResult): SpendingInsight[] {
  const cascade = computeCascade(data);
  if (!cascade) return [];

  const { triggerDay, windowEndDay, events: cascadeEvents } = cascade;
  const series = data.series;
  const balanceBeforeTrigger =
    triggerDay.dayOffset === 1
      ? data.startingBalance
      : series[triggerDay.dayOffset - 2]?.balance ?? data.startingBalance;

  const insights: SpendingInsight[] = [];

  function pushInsight(e: DayEvent, day: (typeof series)[number], role: InsightRole) {
    const category = classify(e.name);
    const name = titleCase(e.name);
    const id = `${role}-${e.name}-${day.dayOffset}`;
    const actionable = category === "discretionary";
    const whatIfChange: WhatIfChange | null = actionable
      ? {
          kind: "skip_stream",
          streamName: e.name,
          label: `Skip ${name} (${formatMoney(e.amount)})`,
        }
      : null;

    let headline = "";
    let detail = "";

    if (role === "trigger") {
      headline = `${name} (${formatMoney(e.amount)}) on ${formatDateLabel(day.date)} is the main reason you go under.`;
      detail = `The balance was ${formatMoney(balanceBeforeTrigger)} the day before: this single payment takes it to ${formatMoney(day.balance)}.`;
    } else if (role === "erosion") {
      const daysBeforeTrigger = triggerDay.dayOffset - day.dayOffset;
      headline = `${name} (${formatMoney(e.amount)}) on ${formatDateLabel(day.date)} leaves only ${formatMoney(day.balance)} in the account: no cushion left when ${titleCase(triggerDay.events.find((ev) => !ev.isIncome)?.name ?? "the next bill")} hits ${daysBeforeTrigger} day${daysBeforeTrigger === 1 ? "" : "s"} later.`;
      detail = `Without it, the balance would have carried ${formatMoney(day.balance + e.amount)} into that day instead.`;
    } else {
      const feeEvent = cascadeEvents.find((ev) => ev.dayOffset === day.dayOffset);
      headline = `${name} (${formatMoney(e.amount)}) on ${formatDateLabel(day.date)} lands while the account is already underwater, pushing the balance to ${formatMoney(day.balance)}.`;
      detail = feeEvent
        ? `Because the account is already negative, this also triggers another ${formatMoney(feeEvent.fee)} overdraft fee.`
        : `It doesn't cause the overdraft, but it deepens it while the account is already underwater.`;
    }

    insights.push({
      id,
      streamName: e.name,
      amount: e.amount,
      date: day.date,
      dayOffset: day.dayOffset,
      role,
      category,
      headline,
      detail,
      actionable,
      whatIfChange,
    });
  }

  // 1. The trigger: whatever debit(s) actually cross the balance below zero.
  for (const e of triggerDay.events.filter((ev) => !ev.isIncome && !ev.isEstimated)) {
    pushInsight(e, triggerDay, "trigger");
  }

  // 2. Buffer erosion: debits BEFORE the trigger day that ate into the
  //    cushion, so there was less room left when the trigger hit.
  for (const day of series) {
    if (day.dayOffset >= triggerDay.dayOffset) break;
    for (const e of day.events.filter((ev) => !ev.isIncome && !ev.isEstimated)) {
      pushInsight(e, day, "erosion");
    }
  }

  // 3. Deepens: debits landing strictly inside the danger window, after the
  //    trigger: they don't cause the overdraft, but they extend it while
  //    it's already happening (and often trigger their own bounce fee).
  for (const day of series) {
    if (day.dayOffset <= triggerDay.dayOffset || day.dayOffset > windowEndDay.dayOffset) continue;
    for (const e of day.events.filter((ev) => !ev.isIncome && !ev.isEstimated)) {
      pushInsight(e, day, "deepens");
    }
  }

  // Ranked by real dollar contribution: the trigger naturally sorts first
  // in every real scenario since it's what actually crosses zero.
  return insights.sort((a, b) => b.amount - a.amount);
}
