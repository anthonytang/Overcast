/**
 * Overcast: forecast engine.
 *
 * Ported directly from spike_forecast.py (the proven logic: do not reinvent).
 * Recurring streams (income + bills, each with a cadence and a "first_day" offset)
 * are projected forward against a starting balance to find danger days
 * (balance < buffer). In production, streams come from Plaid's
 * /transactions/recurring/get; for the demo we use a defined scenario so the
 * exact overdraft is deterministic and network-independent.
 */

export interface Stream {
  name: string;
  amount: number;
  cadenceDays: number;
  isIncome: boolean;
  /** Days from projection start until the first occurrence of this stream. */
  firstDay: number;
  /** Statistical/velocity projection, not a bill that can independently bounce. */
  isEstimated?: boolean;
}

export interface DayEvent {
  name: string;
  amount: number;
  isIncome: boolean;
  isEstimated?: boolean;
}

export interface ForecastDay {
  /** ISO date string (YYYY-MM-DD). */
  date: string;
  /** Day offset from today, 1-indexed. */
  dayOffset: number;
  balance: number;
  /** Deterministic balance before variable-spend simulation is applied. */
  expectedBalance?: number;
  /** 10th/90th percentile balance from the connected-bank risk model. */
  confidenceLow?: number;
  confidenceHigh?: number;
  /** Chance (0 to 1) of being below the waterline on this date. */
  overdraftProbability?: number;
  events: DayEvent[];
  isDanger: boolean;
}

export interface ForecastResult {
  startingBalance: number;
  buffer: number;
  horizonDays: number;
  series: ForecastDay[];
  dangerDays: ForecastDay[];
  source?: "demo" | "plaid";
  accountName?: string;
  modelNote?: string;
  streams?: Stream[];
  risk?: {
    simulationCount: number;
    historyDays: number;
    modelVersion: string;
    modelFamily?: string;
    calibrationRadius?: number;
    calibrationWindows?: number;
    calibrationHorizonDays?: number;
    calibrationCoverage?: number;
    calibrationMae?: number;
    drift?: { status: "stable" | "watch" | "elevated" | "limited_history"; recentDailySpend: number; priorDailySpend: number | null; change: number | null };
    tailStressMultiplier?: number;
    uncertaintyMultiplier?: number;
    pendingTransactionCount?: number;
    pendingBalanceGap?: number | null;
  };
  /** A server-computed constrained plan. It is advisory only and cannot move
   * money or contact a biller. */
  decisionPlan?: {
    riskTarget: number;
    beforeRisk: number;
    candidateCount: number;
    status: "solved" | "no_single_action_found";
    recommended: null | {
      type: "transfer" | "defer" | "reduce_spending" | "combo";
      amount: number;
      risk: number;
      explanation: string;
      streamName?: string;
      days?: number;
      percent?: number;
      day?: number;
    };
    alternatives?: Array<{
      type: "transfer" | "defer" | "reduce_spending" | "combo";
      amount: number;
      risk: number;
      explanation: string;
      streamName?: string;
      days?: number;
      percent?: number;
      day?: number;
    }>;
  };
  robustness?: {
    tailRiskBefore: number;
    tailRiskAfter: number | null;
    stressMultiplier: number;
    usedRobustPlan: boolean;
    baselineCandidateCount: number;
    robustCandidateCount: number;
    scenarios?: string[];
  };
  waitingPolicy?: {
    riskTarget: number;
    status: "wait_safe" | "act_now" | "no_safe_wait";
    actionNow: { day: number; amount: number; risk: number; feasible: boolean } | null;
    latestSafe: { day: number; amount: number; risk: number; feasible: boolean } | null;
    options: Array<{ day: number; amount: number; risk: number; feasible: boolean }>;
  };
  sequentialPolicy?: {
    status: "wait_safe" | "act_now" | "no_safe_wait";
    actionNowAmount: number;
    latestSafeDay: number | null;
    latestSafeExpectedAmount: number | null;
    informationValue: number;
    observationModel: string;
    stages: Array<{ day: number; expectedAmount: number; expectedRisk: number; safeProbability: number; stateCount: number; states: Array<{ weight: number; amount: number; risk: number; feasible: boolean }> }>;
  };
  pendingImpact?: { withoutPendingRisk: number; withPendingRisk: number };
  /** Internal simulation outcomes, retained so deterministic What-Ifs and
   * fixes can precisely re-evaluate risk without inventing a new model. */
  riskSamples?: number[][];
  transparency?: {
    lastSyncedAt: string | null;
    transactionCount: number;
    variableTransactionCount: number;
    latestTransactionDate: string | null;
    recurringIncomeCount: number;
    recurringBillCount: number;
    /** Historical mix of variable spending. Used only for transparent,
     * same-path category counterfactuals, never merchant-level guesses. */
    variableSpendingCategories?: Array<{ name: string; share: number }>;
    analyticsEngine?: "calibrated" | "local_fallback";
  };
}

/** The defined demo scenario: same streams as spike_forecast.py's STREAMS. */
export const DEMO_STARTING_BALANCE = 500.0;
export const DEMO_BUFFER = 0.0;
export const DEMO_HORIZON_DAYS = 30;

export const DEMO_STREAMS: Stream[] = [
  { name: "ACME PAYROLL", amount: 1200.0, cadenceDays: 14, isIncome: true, firstDay: 8 },
  { name: "SUNNYSIDE RENT", amount: 1100.0, cadenceDays: 30, isIncome: false, firstDay: 3 },
  { name: "CITY ELECTRIC", amount: 140.0, cadenceDays: 30, isIncome: false, firstDay: 12 },
  { name: "GROCERY MART", amount: 85.0, cadenceDays: 7, isIncome: false, firstDay: 2 },
  { name: "STREAMFLIX", amount: 15.99, cadenceDays: 30, isIncome: false, firstDay: 5 },
  { name: "MUSICWAVE", amount: 9.99, cadenceDays: 30, isIncome: false, firstDay: 9 },
];

function toIsoDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Project recurring streams forward from `start` over `horizon` days,
 * mirroring spike_forecast.py's project() exactly.
 */
export function project(
  streams: Stream[],
  startingBalance: number,
  buffer: number,
  horizonDays: number,
  today: Date = new Date()
): ForecastResult {
  const delta = new Map<number, number>();
  const events = new Map<number, DayEvent[]>();

  for (const s of streams) {
    let day = s.firstDay;
    while (day <= horizonDays) {
      const sign = s.isIncome ? 1 : -1;
      delta.set(day, (delta.get(day) ?? 0) + sign * s.amount);
      const dayEvents = events.get(day) ?? [];
      dayEvents.push({ name: s.name, amount: s.amount, isIncome: s.isIncome, isEstimated: s.isEstimated });
      events.set(day, dayEvents);
      day += s.cadenceDays;
    }
  }

  let balance = startingBalance;
  const series: ForecastDay[] = [];
  for (let d = 1; d <= horizonDays; d++) {
    balance = round2(balance + (delta.get(d) ?? 0));
    const date = new Date(today);
    date.setDate(date.getDate() + d);
    const isDanger = balance < buffer;
    series.push({
      date: toIsoDate(date),
      dayOffset: d,
      balance,
      expectedBalance: balance,
      events: events.get(d) ?? [],
      isDanger,
    });
  }

  return {
    startingBalance,
    buffer,
    horizonDays,
    series,
    dangerDays: series.filter((day) => day.isDanger),
    streams,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Runs the projection against the fixed demo scenario. */
export function runDemoForecast(today: Date = new Date()): ForecastResult {
  return project(DEMO_STREAMS, DEMO_STARTING_BALANCE, DEMO_BUFFER, DEMO_HORIZON_DAYS, today);
}

/**
 * Recovers the `today` anchor a ForecastResult was projected from, so a fix
 * recomputation lines up on the exact same calendar dates as the original  - 
 * regardless of client/server clock skew between the two project() calls.
 */
export function deriveTodayFromSeries(series: ForecastDay[]): Date {
  const first = series[0];
  const d = new Date(`${first.date}T00:00:00`);
  d.setDate(d.getDate() - first.dayOffset);
  return d;
}
