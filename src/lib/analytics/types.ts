import type { Stream } from "@/lib/forecast";

export type AnalyticsTransaction = {
  amount: number;
  postedDate: string;
  description: string;
  primaryCategory?: string | null;
  detailedCategory?: string | null;
};

export type AnalyticsRequest = {
  startingBalance: number;
  buffer: number;
  horizonDays: number;
  startDate: string;
  streams: Stream[];
  transactions: AnalyticsTransaction[];
  savingsAvailable: number;
  availableBalance?: number | null;
  currentBalance?: number | null;
  pendingTransactions?: Array<{ amount: number; authorizedDate: string; description: string }>;
};

export type DecisionPlan = {
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

export type AnalyticsResponse = {
  series: Array<{
    date: string;
    dayOffset: number;
    balance: number;
    expectedBalance: number;
    confidenceLow: number;
    confidenceHigh: number;
    overdraftProbability: number;
    isDanger: boolean;
    events: Array<{ name: string; amount: number; isIncome: boolean; isEstimated?: boolean }>;
  }>;
  riskSamples: number[][];
  risk: {
    simulationCount: number;
    historyDays: number;
    modelVersion: string;
    modelFamily: string;
    calibrationRadius: number;
    calibrationWindows: number;
    calibrationHorizonDays?: number;
    calibrationCoverage?: number;
    calibrationMae?: number;
    drift?: { status: "stable" | "watch" | "elevated" | "limited_history"; recentDailySpend: number; priorDailySpend: number | null; change: number | null };
    tailStressMultiplier?: number;
    uncertaintyMultiplier?: number;
    pendingTransactionCount?: number;
    pendingBalanceGap?: number | null;
  };
  optimizer: DecisionPlan;
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
};
