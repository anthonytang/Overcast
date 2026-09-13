export interface BacktestResult {
  modelVersion: string;
  horizonDays: number;
  windowCount: number;
  actualRiskWindows: number;
  predictedRiskWindows: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  meanPredictedRisk: number | null;
  status: "ready" | "insufficient_history";
  note: string;
}

type HistoricalTransaction = { amount: number; postedDate: string };

const HORIZON_DAYS = 7;
const HISTORY_DAYS = 14;
const SIMULATIONS = 240;

function key(date: Date) { return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; }
function parseDate(iso: string) { return new Date(`${iso}T00:00:00`); }
function round4(value: number) { return Math.round(value * 10_000) / 10_000; }

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

/**
 * Rolling-origin validation. For each historical anchor, the model is shown
 * only prior daily cash-flow observations, predicts the following week, then
 * compares that prediction with the transaction-derived balance path that
 * actually followed. It deliberately reports no metric for short history.
 */
export function backtestForecast(currentBalance: number, transactions: HistoricalTransaction[]): BacktestResult {
  const usable = transactions
    .map((transaction) => ({ ...transaction, date: parseDate(transaction.postedDate) }))
    .filter((transaction) => Number.isFinite(transaction.date.getTime()) && Number.isFinite(transaction.amount));
  if (usable.length === 0) return insufficient("No posted transactions are available yet.");

  const first = new Date(Math.min(...usable.map((transaction) => transaction.date.getTime())));
  const last = new Date(Math.max(...usable.map((transaction) => transaction.date.getTime())));
  const calendarDays = Math.floor((last.getTime() - first.getTime()) / 86_400_000) + 1;
  if (calendarDays < HISTORY_DAYS + HORIZON_DAYS + 1) {
    return insufficient(`Needs ${HISTORY_DAYS + HORIZON_DAYS + 1} calendar days; this item has ${calendarDays}.`);
  }

  const netByDay = new Map<string, number>();
  for (const transaction of usable) {
    // Plaid uses positive amounts for debits and negative amounts for credits.
    netByDay.set(key(transaction.date), (netByDay.get(key(transaction.date)) ?? 0) - transaction.amount);
  }
  const dates: Date[] = [];
  for (let cursor = new Date(first); cursor <= last; cursor.setDate(cursor.getDate() + 1)) dates.push(new Date(cursor));

  // Reconstruct end-of-day balances backwards from the most recently synced
  // account balance. This is explicitly transaction-derived, not a claim that
  // Plaid supplied a historical daily balance series.
  const endBalance = new Map<string, number>();
  let balance = currentBalance;
  for (let index = dates.length - 1; index >= 0; index -= 1) {
    const date = dates[index];
    endBalance.set(key(date), balance);
    balance -= netByDay.get(key(date)) ?? 0;
  }

  let windows = 0;
  let actualRiskWindows = 0;
  let predictedRiskWindows = 0;
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let totalProbability = 0;
  const random = seededRandom(Math.round(usable.reduce((total, transaction) => total + transaction.amount * 100 + transaction.date.getTime() / 86_400_000, 0)));

  for (let origin = HISTORY_DAYS - 1; origin + HORIZON_DAYS < dates.length; origin += 1) {
    const historical = dates.slice(origin - HISTORY_DAYS + 1, origin + 1).map((date) => netByDay.get(key(date)) ?? 0);
    const historicalByWeekday = Array.from({ length: 7 }, () => [] as number[]);
    dates.slice(origin - HISTORY_DAYS + 1, origin + 1).forEach((date) => historicalByWeekday[date.getDay()].push(netByDay.get(key(date)) ?? 0));
    const startBalance = endBalance.get(key(dates[origin])) ?? 0;
    let belowCount = 0;
    for (let simulation = 0; simulation < SIMULATIONS; simulation += 1) {
      let simulatedBalance = startBalance;
      let underwater = false;
      for (let step = 1; step <= HORIZON_DAYS; step += 1) {
        const futureDate = dates[origin + step];
        const pool = historicalByWeekday[futureDate.getDay()].length >= 2 ? historicalByWeekday[futureDate.getDay()] : historical;
        simulatedBalance += pool[Math.floor(random() * pool.length)] ?? 0;
        if (simulatedBalance < 0) underwater = true;
      }
      if (underwater) belowCount += 1;
    }
    const probability = belowCount / SIMULATIONS;
    const predictedRisk = probability >= 0.5;
    const actualRisk = dates.slice(origin + 1, origin + HORIZON_DAYS + 1)
      .some((date) => (endBalance.get(key(date)) ?? 0) < 0);
    windows += 1;
    totalProbability += probability;
    if (actualRisk) actualRiskWindows += 1;
    if (predictedRisk) predictedRiskWindows += 1;
    if (predictedRisk && actualRisk) truePositives += 1;
    if (predictedRisk && !actualRisk) falsePositives += 1;
    if (!predictedRisk && actualRisk) falseNegatives += 1;
  }

  return {
    modelVersion: "cashflow-bootstrap-backtest-v1",
    horizonDays: HORIZON_DAYS,
    windowCount: windows,
    actualRiskWindows,
    predictedRiskWindows,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: predictedRiskWindows > 0 ? round4(truePositives / predictedRiskWindows) : null,
    recall: actualRiskWindows > 0 ? round4(truePositives / actualRiskWindows) : null,
    meanPredictedRisk: windows > 0 ? round4(totalProbability / windows) : null,
    status: "ready",
    note: "Rolling 7-day transaction-ledger validation using only prior cash-flow history at each historical anchor. Balances are reconstructed from the current synced balance and posted transactions.",
  };
}

function insufficient(note: string): BacktestResult {
  return {
    modelVersion: "cashflow-bootstrap-backtest-v1",
    horizonDays: HORIZON_DAYS,
    windowCount: 0,
    actualRiskWindows: 0,
    predictedRiskWindows: 0,
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    precision: null,
    recall: null,
    meanPredictedRisk: null,
    status: "insufficient_history",
    note,
  };
}
