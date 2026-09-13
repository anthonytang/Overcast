import type { ForecastDay, ForecastResult } from "./forecast";

export interface HistoricalSpend {
  amount: number;
  postedDate: string;
}

const SIMULATION_COUNT = 320;

function seededRandom(seed: number) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function quantile(sorted: number[], percentile: number) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * percentile)));
  return sorted[index];
}

function round2(value: number) { return Math.round(value * 100) / 100; }

function dayKey(date: Date) { return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; }

/**
 * Bootstraps future variable spending from actual daily transaction totals.
 * Sampling is deterministic for a given history, so a refresh only changes
 * the forecast when Plaid data changes - not on arbitrary page reloads.
 */
export function attachRiskModel(base: ForecastResult, transactions: HistoricalSpend[], today: Date): ForecastResult {
  const parsed = transactions
    .map((transaction) => ({ ...transaction, date: new Date(`${transaction.postedDate}T00:00:00`) }))
    .filter((transaction) => Number.isFinite(transaction.date.getTime()) && transaction.amount > 0);
  if (parsed.length === 0) return base;

  const earliest = new Date(Math.min(...parsed.map((transaction) => transaction.date.getTime())));
  earliest.setHours(0, 0, 0, 0);
  const anchor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const historyDays = Math.max(1, Math.min(90, Math.floor((anchor.getTime() - earliest.getTime()) / 86_400_000) + 1));
  const daily = new Map<string, number>();
  for (const transaction of parsed) daily.set(dayKey(transaction.date), (daily.get(dayKey(transaction.date)) ?? 0) + transaction.amount);

  const byWeekday = Array.from({ length: 7 }, () => [] as number[]);
  const allDays: number[] = [];
  for (let offset = 0; offset < historyDays; offset += 1) {
    const date = new Date(anchor);
    date.setDate(date.getDate() - offset);
    const spend = round2(daily.get(dayKey(date)) ?? 0);
    byWeekday[date.getDay()].push(spend);
    allDays.push(spend);
  }
  // The deterministic line uses this exact expected-spend event. Keeping the
  // replacement value identical prevents the simulation from double-counting
  // or silently changing the baseline as it samples uncertainty.
  const expectedDailySpend = base.series[0]?.events.find((event) => event.isEstimated)?.amount
    ?? allDays.reduce((total, amount) => total + amount, 0) / allDays.length;
  const seed = Math.round(parsed.reduce((total, transaction) => total + transaction.amount * 100 + transaction.date.getTime() / 86_400_000, 0));
  const random = seededRandom(seed);
  const samplesByDay = base.series.map(() => [] as number[]);

  for (let simulation = 0; simulation < SIMULATION_COUNT; simulation += 1) {
    let balance = base.startingBalance;
    base.series.forEach((day, index) => {
      const date = new Date(`${day.date}T00:00:00`);
      const pool = byWeekday[date.getDay()].length >= 3 ? byWeekday[date.getDay()] : allDays;
      const variableSpend = pool[Math.floor(random() * pool.length)] ?? expectedDailySpend;
      const deterministicDelta = (day.expectedBalance ?? day.balance) - (index === 0 ? base.startingBalance : (base.series[index - 1].expectedBalance ?? base.series[index - 1].balance));
      // The base projection already subtracts expected variable spend once;
      // replace it with a sampled observed day for this simulation.
      balance = balance + deterministicDelta + expectedDailySpend - variableSpend;
      samplesByDay[index].push(round2(balance));
    });
  }

  const series: ForecastDay[] = base.series.map((day, index) => {
    const outcomes = [...samplesByDay[index]].sort((a, b) => a - b);
    const median = quantile(outcomes, 0.5);
    return {
      ...day,
      balance: median,
      confidenceLow: quantile(outcomes, 0.1),
      confidenceHigh: quantile(outcomes, 0.9),
      overdraftProbability: outcomes.filter((balance) => balance < base.buffer).length / outcomes.length,
      isDanger: median < base.buffer,
    };
  });
  return {
    ...base,
    series,
    dangerDays: series.filter((day) => day.isDanger),
    risk: { simulationCount: SIMULATION_COUNT, historyDays, modelVersion: "weekday-bootstrap-v1" },
    riskSamples: samplesByDay,
  };
}

/** Exact risk update for a deterministic intervention: every simulation path
 * moves by the intervention's known balance delta at each day. */
export function translateRisk(base: ForecastResult, changed: ForecastResult): ForecastResult {
  if (!base.riskSamples || base.riskSamples.length !== changed.series.length) return changed;
  // The analytics service's expected balance already contains its learned
  // variable-spend median. Do not subtract a second, older deterministic
  // estimate here. Instead, move each stored path only by the intervention's
  // explicit cash-flow delta, plus an intentional estimated-spend reduction.
  const eventValue = (events: ForecastDay["events"] = []) => events
    .filter((event) => !event.isEstimated)
    .reduce((sum, event) => sum + (event.isIncome ? event.amount : -event.amount), 0);
  const estimatedSchedule = (result: ForecastResult, dayIndex: number) => (result.streams ?? [])
    .filter((stream) => stream.isEstimated)
    .reduce((sum, stream) => {
      const day = dayIndex + 1;
      if (day < stream.firstDay || (day - stream.firstDay) % stream.cadenceDays !== 0) return sum;
      return sum + (stream.isIncome ? stream.amount : -stream.amount);
    }, 0);
  let cumulativeDelta = 0;
  const samplesByDay = changed.series.map((day, index) => {
    const knownCashFlowDelta = eventValue(day.events) - eventValue(base.series[index]?.events);
    const estimatedSpendDelta = estimatedSchedule(changed, index) - estimatedSchedule(base, index);
    cumulativeDelta += knownCashFlowDelta + estimatedSpendDelta;
    return base.riskSamples?.[index].map((balance) => round2(balance + cumulativeDelta)) ?? [];
  });
  const series = changed.series.map((day, index) => {
    const outcomes = [...samplesByDay[index]].sort((a, b) => a - b);
    const median = quantile(outcomes, 0.5);
    return {
      ...day,
      balance: median,
      confidenceLow: quantile(outcomes, 0.1),
      confidenceHigh: quantile(outcomes, 0.9),
      overdraftProbability: outcomes.filter((balance) => balance < changed.buffer).length / outcomes.length,
      isDanger: median < changed.buffer,
    };
  });
  return { ...changed, series, dangerDays: series.filter((day) => day.isDanger), risk: base.risk, riskSamples: samplesByDay };
}
