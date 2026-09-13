"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import logoImg from "../../public/logo.png";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity, AlertTriangle, ArrowRight, BadgeCheck, CalendarClock,
  Check, ChevronDown, CircleDollarSign, Copy, Cpu, Download, FileText, Landmark,
  Layers, ListFilter, LoaderCircle, LockKeyhole, LogOut, Menu, RotateCcw,
  ShieldCheck, SlidersHorizontal, Terminal, User, WalletCards, X,
} from "lucide-react";
import type { ForecastResult } from "@/lib/forecast";
import { computeAutoBudget } from "@/lib/budget";
import { computeCascade } from "@/lib/cascade";
import { applyFix } from "@/lib/fix";
import { translateRisk } from "@/lib/risk-model";
import BankConnectionControl from "./BankConnectionControl";
import CashflowChart from "./CashflowChart";
import EngineAnimation, { type AnimationScene } from "./EngineAnimation";

export type View = "position" | "risk" | "test" | "plan" | "spend" | "account";
type AsyncState = "loading" | "ready" | "error";
type ScenarioChoice = "shift" | "transfer" | "spending" | "delay";
type PlanAction = NonNullable<NonNullable<ForecastResult["decisionPlan"]>["recommended"]>;
type Transaction = { id: string; posted_date: string; authorized_date: string | null; description: string; merchant_name: string | null; amount: number | string; primary_category: string | null; detailed_category: string | null; pending: boolean };
type AnimState = "idle" | "playing" | "done";

const ROUTES: Array<{ name: View; label: string }> = [
  { name: "account", label: "Account" }, { name: "position", label: "Cash" },
  { name: "risk", label: "Forecast" }, { name: "test", label: "Simulate" },
  { name: "plan", label: "Fix" }, { name: "spend", label: "Budget" },
];

const VIEW_ANIM_SCENE: Partial<Record<View, AnimationScene>> = {
  position: "position",
  risk: "risk",
  test: "test",
  plan: "plan",
  spend: "spend",
};

const VIEW_ANIM_META: Record<string, { title: string; hint: string; tags: string[] }> = {
  position: {
    title: "Income & Bill Tracker",
    hint: "Checks your recent transactions to find regular income and bill payments.",
    tags: ["Income Streams", "Regular Bills", "Starting Cash"],
  },
  risk: {
    title: "30-Day Balance Forecast",
    hint: "Maps out upcoming paychecks and bills day by day to see if cash dips too low.",
    tags: ["Daily Balances", "Low Cash Alerts", "Timing Check"],
  },
  test: {
    title: "Cash Flow Stress Test",
    hint: "Simulates 1,000 real-world spending scenarios to check your overdraft risk.",
    tags: ["1,000 Simulations", "Spending Swings", "Safety Target"],
  },
  plan: {
    title: "Quick Fix Finder",
    hint: "Tests different adjustments to find the easiest way to keep your balance safe.",
    tags: ["Bill Shifts", "Savings Transfers", "Lowest Effort"],
  },
  spend: {
    title: "Safe Spending Calculator",
    hint: "Sets aside money for bills and a safety cushion so you know what you can freely spend.",
    tags: ["Fixed Bills", "Safety Buffer", "Weekly Allowance"],
  },
};

function money(value: number | null | undefined, digits = 0) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: digits }).format(Number.isFinite(value) ? value ?? 0 : 0);
}
function percent(value: number | null | undefined, digits = 0) { return `${((value ?? 0) * 100).toFixed(digits)}%`; }
function dateLabel(value: string | undefined, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "Date unavailable";
  const date = new Date(value.includes("T") ? value : `${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : new Intl.DateTimeFormat(undefined, options ?? { weekday: "short", month: "short", day: "numeric" }).format(date);
}
export function timeAgo(value: string | null | undefined) {
  if (!value) return "Sync time unavailable";
  const date = new Date(value); if (Number.isNaN(date.getTime())) return "Sync time unavailable";
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000));
  return minutes < 1 ? "Synced just now" : minutes < 60 ? `Synced ${minutes}m ago` : `Synced ${Math.round(minutes / 60)}h ago`;
}
function peakRisk(data: ForecastResult) { return Math.max(0, ...data.series.map((day) => day.overdraftProbability ?? 0)); }
function minimumBalance(data: ForecastResult) { return Math.min(data.startingBalance, ...data.series.map((day) => day.balance)); }
function titleCase(value: string) { return value.toLowerCase().replace(/(^|[\s/(-])([a-z])/g, (_, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`); }
function actionTitle(action: PlanAction | null | undefined) {
  if (!action) return "No intervention is needed right now";
  if (action.type === "transfer") return `Move ${money(action.amount)} from savings`;
  if (action.type === "defer") return `Move ${titleCase(action.streamName ?? "bill")} by ${action.days ?? 0} days`;
  if (action.type === "reduce_spending") return `Lower variable spending by ${Math.round(action.percent ?? 0)}%`;
  return `Combine a ${money(action.amount)} transfer with a timing change`;
}
function applyPlan(base: ForecastResult, action: PlanAction | null) {
  if (!action || !base.streams) return base;
  const changed = applyFix(base, base.streams, { deferSubscription: action.type === "defer" || action.type === "combo", deferStreamName: action.streamName, deferDays: action.days, transferAmount: action.type === "transfer" || action.type === "combo" ? action.amount : 0, transferDay: action.day, reduceEstimatedSpendPercent: action.type === "reduce_spending" ? action.percent : undefined });
  return translateRisk(base, changed);
}
export function MiniWaterline({ data, comparison = false }: { data: ForecastResult; comparison?: boolean }) {
  return <CashflowChart data={data} compact={!comparison} showConfidence={comparison} label="Projected cash-flow waterline" />;
}

export function AppHeader({
  activeView,
  routeResolved = true,
  onNavigate,
  accountName,
  lastSyncedAt,
  user,
  onSignOut,
}: {
  activeView: View;
  routeResolved?: boolean;
  onNavigate?: (view: View) => void;
  accountName?: string | null;
  lastSyncedAt?: string | null;
  user?: { email: string } | null;
  onSignOut?: () => void;
}) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  function navigate(view: View) {
    if (!onNavigate) return;
    onNavigate(view);
    setMobileNavOpen(false);
  }
  return <>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <header className="app-header"><div className="app-header__inner">
      <button type="button" className="brand" onClick={() => navigate("account")} aria-label="Overcast home" disabled={!onNavigate}>
        <span className="brand__mark"><Image src={logoImg} alt="Overcast logo" width={34} height={34} className="brand__img" priority /></span>
        <span><strong>Overcast</strong><small>Cash flow forecast</small></span>
      </button>
      <nav className={`app-nav ${mobileNavOpen ? "is-open" : ""}`} aria-label="Primary navigation">
        {ROUTES.map((item) => {
          const isActive = routeResolved && activeView === item.name;
          return <button key={item.name} type="button" className={isActive ? "is-active" : ""} aria-current={isActive ? "page" : undefined} onClick={() => navigate(item.name)} disabled={!onNavigate}>{item.label}</button>;
        })}
      </nav>
      <div className="header-account-actions">
        <div className="account-chip"><i /><span>{accountName ?? "Loading account"}</span><b>·</b><span>{lastSyncedAt ? timeAgo(lastSyncedAt) : "Syncing"}</span></div>
        {user && onSignOut && (
          <button
            type="button"
            className="header-user-btn"
            onClick={onSignOut}
            title="Sign out of Overcast"
            aria-label={`Signed in as ${user.email}. Click to sign out`}
          >
            <User size={13} />
            <span>{user.email.split("@")[0]}</span>
            <LogOut size={12} />
          </button>
        )}
      </div>
      <button className="mobile-menu" type="button" onClick={() => setMobileNavOpen((open) => !open)} aria-expanded={mobileNavOpen} aria-label="Toggle navigation">{mobileNavOpen ? <X /> : <Menu />}</button>
    </div></header>
  </>;
}

function ViewGate({
  viewKey,
  children,
  data,
  animState,
  onStart,
  onComplete,
}: {
  viewKey: View;
  children: React.ReactNode;
  data: ForecastResult;
  animState: AnimState;
  onStart: (view: View) => void;
  onComplete: (view: View) => void;
}) {
  const scene = VIEW_ANIM_SCENE[viewKey];
  const meta = scene ? VIEW_ANIM_META[viewKey] : null;
  if (!scene || !meta) return <>{children}</>;
  if (animState === "done") return (
    <motion.div
      className="engine-screen-reveal"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="engine-replay-control">
        <button type="button" onClick={() => onStart(viewKey)} title="Replay the step-by-step animation">
          <RotateCcw size={12} /> Replay walkthrough
        </button>
      </div>
      {children}
    </motion.div>
  );
  if (animState === "playing") {
    return <div className="eng-anim-wrapper"><EngineAnimation scene={scene} data={data} onComplete={() => onComplete(viewKey)} /></div>;
  }
  return (
    <div className="eng-anim-trigger">
      <div className="eng-anim-trigger__copy">
        <p className="eng-anim-trigger__eyebrow">Guided analysis</p>
        <h2 className="eng-anim-trigger__title">{meta.title}</h2>
        <p className="eng-anim-trigger__hint">{meta.hint}</p>
        <div className="eng-anim-trigger__tags" aria-label="This analysis covers">
          {meta.tags.map((tag) => <span key={tag} className="eng-anim-trigger__tag">{tag}</span>)}
        </div>
      </div>
      <div className="eng-anim-trigger__actions">
        <button className="eng-anim-trigger__btn" type="button" onClick={() => onStart(viewKey)}>See how it works <ArrowRight size={15} /></button>
        <button className="eng-anim-trigger__skip" type="button" onClick={() => onComplete(viewKey)}>Skip to Numbers <ArrowRight size={13} /></button>
      </div>
    </div>
  );
}

export default function OvercastWorkspace({
  data,
  activeView: view,
  onNavigate,
}: {
  data: ForecastResult;
  activeView: View;
  onNavigate: (view: View) => void;
}) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [activityState, setActivityState] = useState<AsyncState>("loading");
  const [connection, setConnection] = useState<{ connected: boolean; lastSyncedAt: string | null; webhookConfigured: boolean } | null>(null);
  const [scenarioChoice, setScenarioChoice] = useState<ScenarioChoice>("shift");
  const [scenarioResult, setScenarioResult] = useState<ForecastResult | null>(null);
  const [scenarioState, setScenarioState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [scenarioError, setScenarioError] = useState<string | null>(null);
  const [nlpPrompt, setNlpPrompt] = useState("");
  const [nlpLoading, setNlpLoading] = useState(false);
  const [nlpExplanation, setNlpExplanation] = useState<string | null>(null);
  const [ledgerFilter, setLedgerFilter] = useState<"all" | "income" | "bills" | "discretionary">("all");
  const [hardshipOpen, setHardshipOpen] = useState(false);
  const [hardshipLoading, setHardshipLoading] = useState(false);
  const [hardshipStrategy, setHardshipStrategy] = useState<"extension" | "split" | "waiver">("extension");
  const [hardshipData, setHardshipData] = useState<{ letter: string[]; facts?: { recipient: string; amountDue: number; dueDate: string }; strategy?: string; strategies?: Array<{ key: string; title: string; description: string }>; model?: string } | null>(null);
  const [hardshipError, setHardshipError] = useState<string | null>(null);
  const [copiedToast, setCopiedToast] = useState(false);
  const [shapleyDiagnostic, setShapleyDiagnostic] = useState<{ headline: string; summary: string; primaryDriver: string; timingShare: number } | null>(null);
  const [auditData, setAuditData] = useState<{ subscriptions: Array<{ name: string; amount: number; cadence: string; category: string }>; monthlySubscriptionTotal: number; anomalies: Array<{ merchant: string; note: string; severity: string }>; aiSummary: string } | null>(null);
  const [expandedAuditSection, setExpandedAuditSection] = useState<"subscriptions" | "recurring" | "anomalies" | null>(null);
  // Track animation state per-view so re-navigation doesn't replay
  const [animStates, setAnimStates] = useState<Partial<Record<View, AnimState>>>({});
  const getAnimState = (v: View): AnimState => animStates[v] ?? "idle";
  const startAnim = useCallback((v: View) => setAnimStates((prev) => ({ ...prev, [v]: "playing" })), []);
  const completeAnim = useCallback((v: View) => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    setAnimStates((prev) => ({ ...prev, [v]: "done" }));
  }, []);

  const risk = peakRisk(data);
  const danger = data.dangerDays[0] ?? data.series.find((day) => (day.overdraftProbability ?? 0) > 0.5) ?? null;
  const primaryBill = useMemo(() => (data.streams ?? []).filter((stream) => !stream.isIncome && !stream.isEstimated).sort((a, b) => b.amount - a.amount)[0], [data.streams]);
  const primaryIncome = useMemo(() => (data.streams ?? []).find((stream) => stream.isIncome), [data.streams]);
  const flexibleStream = useMemo(() => (data.streams ?? []).find((stream) => stream.isEstimated) ?? (data.streams ?? []).find((stream) => !stream.isIncome && stream !== primaryBill), [data.streams, primaryBill]);
  const incomeStreams = useMemo(() => (data.streams ?? []).filter((s) => s.isIncome), [data.streams]);
  const billStreams = useMemo(() => (data.streams ?? []).filter((s) => !s.isIncome), [data.streams]);
  const totalIncome = useMemo(() => incomeStreams.reduce((sum, s) => sum + s.amount, 0), [incomeStreams]);
  const totalBills = useMemo(() => billStreams.reduce((sum, s) => sum + s.amount, 0), [billStreams]);
  const netMonthlyCashflow = totalIncome - totalBills;
  const pendingTransactions = transactions.filter((transaction) => transaction.pending);
  const pendingTotal = pendingTransactions.reduce((sum, transaction) => sum + Math.max(0, Number(transaction.amount)), 0);
  const pendingGap = Math.max(0, data.risk?.pendingBalanceGap ?? pendingTotal);
  const availableLiquidity = data.startingBalance - pendingGap;
  const recommendedPlan = data.decisionPlan?.recommended ?? null;
  const rescuedForecast = useMemo(() => applyPlan(data, recommendedPlan), [data, recommendedPlan]);
  const budget = useMemo(() => computeAutoBudget(data, data.streams ?? []), [data]);
  const safeWeekly = Math.max(0, budget.totalDiscretionaryMonthlyRate / 4.33);
  const cascade = useMemo(() => computeCascade(data), [data]);
  const lastSafeDay = data.sequentialPolicy?.latestSafeDay ?? data.waitingPolicy?.latestSafe?.day ?? recommendedPlan?.day ?? 1;
  const lastSafeDate = data.series[Math.max(0, Math.min(data.series.length - 1, lastSafeDay - 1))]?.date;

  useEffect(() => {
    fetch("/api/connection", { cache: "no-store" }).then((response) => response.ok ? response.json() : null).then(setConnection).catch(() => undefined);
    fetch("/api/activity", { cache: "no-store" }).then((response) => response.ok ? response.json() : Promise.reject()).then((payload) => { setTransactions(Array.isArray(payload.transactions) ? payload.transactions : []); setActivityState("ready"); }).catch(() => setActivityState("error"));
    fetch("/api/attribution", { cache: "no-store" }).then((res) => res.ok ? res.json() : null).then((payload) => { if (payload?.aiDiagnostic) setShapleyDiagnostic(payload.aiDiagnostic); }).catch(() => undefined);
    fetch("/api/activity/audit", { cache: "no-store" }).then((res) => res.ok ? res.json() : null).then(setAuditData).catch(() => undefined);
  }, []);

  const isIncomeTx = useCallback((t: Transaction) => {
    const amt = Number(t.amount);
    const cat = `${t.primary_category ?? ""} ${t.detailed_category ?? ""} ${t.merchant_name ?? ""} ${t.description ?? ""}`.toLowerCase();
    return amt < 0 || cat.includes("payroll") || cat.includes("deposit") || cat.includes("salary") || cat.includes("income") || cat.includes("interest");
  }, []);

  const isBillTx = useCallback((t: Transaction) => {
    const cat = `${t.primary_category ?? ""} ${t.detailed_category ?? ""} ${t.merchant_name ?? ""} ${t.description ?? ""}`.toLowerCase();
    return (
      cat.includes("utilities") || cat.includes("rent") || cat.includes("insurance") ||
      cat.includes("telecom") || cat.includes("subscription") || cat.includes("loan") ||
      cat.includes("mortgage") || cat.includes("electric") || cat.includes("water") || cat.includes("service")
    );
  }, []);

  const filteredTransactions = useMemo(() => {
    if (ledgerFilter === "income") return transactions.filter(isIncomeTx);
    if (ledgerFilter === "bills") return transactions.filter((t) => !isIncomeTx(t) && isBillTx(t));
    if (ledgerFilter === "discretionary") return transactions.filter((t) => !isIncomeTx(t) && !isBillTx(t));
    return transactions;
  }, [transactions, ledgerFilter, isIncomeTx, isBillTx]);

  async function handleNlpSubmit(customPrompt?: string) {
    const textToRun = (customPrompt ?? nlpPrompt).trim();
    if (!textToRun) return;
    setNlpLoading(true);
    setScenarioState("loading");
    setScenarioError(null);
    try {
      const response = await fetch("/api/whatif/nlp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: textToRun }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.result) throw new Error(payload.error ?? "Could not simulate scenario");
      setScenarioResult(payload.result);
      setNlpExplanation(payload.explanation ?? `Simulated: "${textToRun}"`);
      setScenarioState("ready");
      if (customPrompt) setNlpPrompt(customPrompt);
    } catch (err) {
      setScenarioState("error");
      setScenarioError(err instanceof Error ? err.message : "Could not process NLP scenario");
    } finally {
      setNlpLoading(false);
    }
  }

  async function openHardshipModal(strategyChoice?: "extension" | "split" | "waiver") {
    const chosen = strategyChoice ?? hardshipStrategy;
    setHardshipStrategy(chosen);
    setHardshipOpen(true);
    setHardshipLoading(true);
    setHardshipError(null);
    try {
      const response = await fetch("/api/hardship-letter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy: chosen }),
      });
      const json = await response.json();
      if (!response.ok || json.error) {
        throw new Error(json.error ?? "Could not draft negotiation letter");
      }
      setHardshipData(json);
    } catch (err) {
      setHardshipError(err instanceof Error ? err.message : "Could not draft negotiation letter");
    } finally {
      setHardshipLoading(false);
    }
  }

  function handleCopyLetter() {
    if (!hardshipData?.letter) return;
    const text = hardshipData.letter.join("\n\n");
    navigator.clipboard.writeText(text);
    setCopiedToast(true);
    setTimeout(() => setCopiedToast(false), 2500);
  }

  function handleDownloadLetter() {
    if (!hardshipData?.letter) return;
    const text = hardshipData.letter.join("\n\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `overcast-negotiation-letter-${(hardshipData.facts?.recipient ?? "bill").toLowerCase().replace(/\s+/g, "-")}-${hardshipStrategy}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function go(nextView: View) {
    onNavigate(nextView);
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function SceneHeading({
    badge,
    badgeType = "safe",
    title,
    subtitle,
  }: {
    badge: React.ReactNode;
    badgeType?: "safe" | "pending" | "risk";
    title: string;
    subtitle: string;
  }) {
    return (
      <header className="scene-heading">
        <AnimatePresence mode="wait">
          <motion.div
            key={title}
            initial={false}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.3 }}
          >
            <span className={`status-badge status-badge--${badgeType}`}>
              {badge}
            </span>
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </motion.div>
        </AnimatePresence>
      </header>
    );
  }

  async function runScenario() {
    if (!data.streams?.length) return;
    setScenarioState("loading"); setScenarioError(null);
    const transferAmount = recommendedPlan?.amount || Math.max(100, Math.ceil(Math.abs(minimumBalance(data))));
    const change = scenarioChoice === "shift" ? { kind: "shift_bill", streamName: primaryBill?.name, days: 3, label: `Move ${primaryBill?.name ?? "bill"} three days later` }
      : scenarioChoice === "transfer" ? { kind: "add_income", amount: transferAmount, label: `Move ${money(transferAmount)} from savings` }
        : scenarioChoice === "spending" ? { kind: "skip_stream", streamName: flexibleStream?.name, label: `Pause ${flexibleStream?.name ?? "discretionary spending"}` }
          : { kind: "delay_income", streamName: primaryIncome?.name, days: 2, label: `Delay ${primaryIncome?.name ?? "paycheck"} by two days` };
    try {
      const response = await fetch("/api/whatif", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ change }) });
      const payload = await response.json();
      if (!response.ok || !payload.result) throw new Error(payload.error ?? "The scenario could not be calculated");
      setScenarioResult(payload.result); setScenarioState("ready");
    } catch (error) { setScenarioState("error"); setScenarioError(error instanceof Error ? error.message : "The scenario could not be calculated"); }
  }
  const actions = (back: View, next: View, label: string) => <div className="scene-actions"><div><button className="button button--text" type="button" onClick={() => go(back)}>{ROUTES.find((route) => route.name === back)?.label}</button></div><button className="button button--primary" type="button" onClick={() => go(next)}>{label}<ArrowRight size={16} /></button></div>;

  return <>
    <main id="main-content" className="scene-canvas"><div key={view} className="scene-enter">
      {view === "position" && <section className="scene scene--wide">
        {(() => {
          const posDone = getAnimState("position") === "done";
          return (
            <SceneHeading
              badge={posDone ? <><BadgeCheck size={14} /> Cash position confirmed</> : <><Cpu size={14} /> Regular Cash Flow</>}
              badgeType="safe"
              title={posDone ? `${money(availableLiquidity, 2)} is safe to plan with today.` : "Find your regular deposits, bills, and starting cash."}
              subtitle={posDone ? `Your bank shows ${money(data.startingBalance, 2)}, but ${money(pendingGap, 2)} is already pending across ${data.streams?.length ?? 6} regular deposits and bills.` : "We check your recent transactions to find your paydays and regular bills, then subtract any pending charges so you know exactly where you stand."}
            />
          );
        })()}
        <ViewGate viewKey="position" data={data} animState={getAnimState("position")} onStart={startAnim} onComplete={completeAnim}>
          <article className="surface account-hero">
            <div className="account-hero__top">
              <span className="icon-tile"><Landmark size={20} /></span>
              <div>
                <h2>{data.accountName ?? "Plaid checking"}</h2>
                <p>Connected primary checking</p>
              </div>
              <span className="status-badge status-badge--safe"><i /> Live sync</span>
            </div>
            <div className="account-hero__formula">
              <div className="formula-item">
                <span>Bank posted</span>
                <strong>{money(data.startingBalance, 2)}</strong>
              </div>
              <div className="formula-operator">-</div>
              <div className="formula-item is-pending">
                <span>Pending charges</span>
                <strong className={pendingGap > 0 ? "text-risk" : ""}>{pendingGap > 0 ? money(pendingGap, 2) : "$0.00"}</strong>
              </div>
              <div className="formula-operator">=</div>
              <div className="formula-item is-cleared">
                <span>Safe to plan with</span>
                <strong className="text-safe">{money(availableLiquidity, 2)}</strong>
              </div>
            </div>
            <p className="account-hero__note">
              {pendingGap > 0 
                ? `${money(pendingGap, 2)} is currently reserved by pending charges, so your plan starts strictly from cleared money.` 
                : "All recent transactions are cleared. Your full bank balance is available to plan with."}
            </p>
          </article>

        <article className="surface streams-summary">
          <div className="streams-summary__head">
            <div className="streams-summary__title">
              <Cpu size={15} className="text-safe" />
              <h3>Detected Regular Cash Flow ({data.streams?.length ?? 0})</h3>
            </div>
            <span>Based on your recent transaction history</span>
          </div>
          <div className="streams-summary__grid">
            {(data.streams ?? []).map((stream) => (
              <div key={stream.name} className="streams-summary__card">
                <div>
                  <div className="stream-badge-row">
                    <span className={`stream-tag ${stream.isIncome ? "stream-tag--income" : "stream-tag--bill"}`}>
                      {stream.isIncome ? "Deposit" : "Bill"}
                    </span>
                    <strong>{titleCase(stream.name)}</strong>
                  </div>
                  <small>Every {stream.cadenceDays} days · Next: Day {stream.firstDay}</small>
                </div>
                <span className={`streams-summary__amount ${stream.isIncome ? "text-safe" : "text-ink"}`}>
                  {stream.isIncome ? "+" : "-"}{money(stream.amount)}
                </span>
              </div>
            ))}
          </div>
          <div className="streams-summary__footer">
            <span>{incomeStreams.length} regular deposits ({money(totalIncome)}/mo)</span>
            <span>·</span>
            <span>{billStreams.length} scheduled bills ({money(totalBills)}/mo)</span>
          </div>
        </article>
        </ViewGate>
        {actions("account", "risk", "Check upcoming bills")}
      </section>}
      {view === "risk" && <section className="scene scene--wide">
        {(() => {
          const riskDone = getAnimState("risk") === "done";
          return (
            <SceneHeading
              badge={riskDone ? <><CalendarClock size={14} /> {danger ? "Timing alert" : "All clear"}</> : <><Cpu size={14} /> 30-Day Cash Forecast</>}
              badgeType={riskDone && danger ? "pending" : "safe"}
              title={riskDone ? (danger ? `A cash dip is expected around ${dateLabel(danger.date)}.` : "Your upcoming bills and income line up safely.") : "See if your upcoming bills and income line up safely."}
              subtitle={riskDone ? (danger ? `${titleCase(primaryBill?.name ?? "A large bill")} comes out before ${titleCase(primaryIncome?.name ?? "payday")}, which could drop your balance to ${money(danger.balance, 2)}.` : "None of your scheduled bills push your account below zero.") : "We map your income and bills day by day over the next month to see if your balance gets too low before your next paycheck."}
            />
          );
        })()}
        <ViewGate viewKey="risk" data={data} animState={getAnimState("risk")} onStart={startAnim} onComplete={completeAnim}>
        {shapleyDiagnostic && (
          <article className="surface shapley-card">
            <div className="shapley-card__head">
              <span className="shapley-card__tag">
                <SlidersHorizontal size={14} /> Shapley Factor Attribution · Explainable Model
              </span>
              <small className="status-badge status-badge--safe">{shapleyDiagnostic.timingShare}% Timing Collision</small>
            </div>
            <h3>{shapleyDiagnostic.headline}</h3>
            <p>{shapleyDiagnostic.summary}</p>
          </article>
        )}
        <article className={`surface forecast-surface forecast-surface--hero ${danger ? "is-risk" : "is-safe"}`}>
          <div className="chart-header">
            <div>
              <span>30-Day Cash Forecast</span>
              <strong>{danger ? `First tight spot: ${dateLabel(danger.date)}` : "No projected dip below zero"}</strong>
            </div>
            <div className="chart-header__badges">
              {danger && (
                <div className="forecast-stat-pill is-deficit">
                  <span>Projected low</span>
                  <strong>{money(danger.balance, 2)}</strong>
                </div>
              )}
              <div className={danger ? "risk-readout is-risk" : "risk-readout is-safe"}>
                <span>Peak risk</span>
                <strong>{percent(risk)}</strong>
              </div>
            </div>
          </div>
          <CashflowChart data={data} showConfidence label="30-day cash-flow forecast" />
        </article>

        {danger ? (
          <article className="surface timing-conflict-card">
            <div className="timing-conflict-card__head">
              <div className="timing-conflict-card__title">
                <CalendarClock size={16} className="text-risk" />
                <h3>Why this dip happens</h3>
              </div>
              <span className="timing-conflict-card__badge">Timing clash detected</span>
            </div>
            <div className="timing-conflict-card__grid">
              <div className="conflict-step conflict-step--trigger">
                <div className="conflict-step__marker">1</div>
                <div className="conflict-step__body">
                  <div className="conflict-step__top">
                    <span className="conflict-step__date">{dateLabel(danger.date)}</span>
                    <span className="conflict-step__amount text-risk">-{money(primaryBill?.amount ?? 0, 2)}</span>
                  </div>
                  <strong>{titleCase(primaryBill?.name ?? "Major Bill")} is due</strong>
                  <p>This payment pulls your account balance down to {money(danger.balance, 2)}.</p>
                </div>
              </div>
              <div className="conflict-step-arrow">
                <ArrowRight size={16} />
              </div>
              <div className="conflict-step conflict-step--recovery">
                <div className="conflict-step__marker">2</div>
                <div className="conflict-step__body">
                  <div className="conflict-step__top">
                    <span className="conflict-step__date">{dateLabel(data.series[Math.max(0, (primaryIncome?.firstDay ?? 17) - 1)]?.date)}</span>
                    <span className="conflict-step__amount text-safe">+{money(primaryIncome?.amount ?? 0, 2)}</span>
                  </div>
                  <strong>{titleCase(primaryIncome?.name ?? "Direct Deposit")} arrives</strong>
                  <p>Your deposit restores your balance, but it arrives a few days after the bill.</p>
                </div>
              </div>
            </div>
            <div className="timing-conflict-card__takeaway">
              <AlertTriangle size={15} />
              <p>
                <strong>The issue is timing, not total income.</strong> Your largest bill arrives before your paycheck, creating a temporary cash shortfall of {money(Math.abs(danger.balance), 2)}.
              </p>
            </div>
          </article>
        ) : (
          <article className="surface timing-conflict-card is-safe">
            <div className="timing-conflict-card__head">
              <div className="timing-conflict-card__title">
                <BadgeCheck size={16} className="text-safe" />
                <h3>All bills cleared safely</h3>
              </div>
              <span className="timing-conflict-card__badge is-safe">Safe schedule</span>
            </div>
            <p className="timing-conflict-card__safe-body">
              Your paychecks and bills are spaced out cleanly. Your account balance remains positive across the next 30 days.
            </p>
          </article>
        )}
        </ViewGate>
        {actions("position", "test", "Test a fix")}
      </section>}
      {view === "test" && <section className="scene scene--wide">
        {(() => {
          const testDone = getAnimState("test") === "done";
          return (
            <SceneHeading
              badge={testDone ? <><ListFilter size={14} /> Baseline risk calculated</> : <><Activity size={14} /> Cash Flow Stress Test</>}
              badgeType="safe"
              title={testDone ? `Starting risk is ${percent(risk)} based on 1,000 simulations.` : "Simulate 1,000 ways this month could play out."}
              subtitle={testDone ? "Pick a quick fix below to see how moving a bill or adding a small backup keeps your balance safe (target: 5% or less)." : "We run 1,000 simulations with realistic spending swings to see how likely you are to run low on cash."}
            />
          );
        })()}
        <ViewGate viewKey="test" data={data} animState={getAnimState("test")} onStart={startAnim} onComplete={completeAnim}>

        <article className="surface nlp-box">
          <div className="nlp-box__head">
            <span className="nlp-box__tag">
              <Terminal size={14} /> Natural Language Scenario Engine
            </span>
            <small className="status-badge status-badge--safe">Structured Execution</small>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleNlpSubmit();
            }}
            className="nlp-bar"
          >
            <input
              type="text"
              className="nlp-bar__input"
              placeholder="Describe a scenario (e.g. 'Paycheck delayed 3 days', 'Shift rent past low cash date', '+$300 bonus')"
              value={nlpPrompt}
              onChange={(e) => setNlpPrompt(e.target.value)}
              disabled={nlpLoading}
            />
            <button
              type="submit"
              className="button button--primary"
              disabled={nlpLoading || !nlpPrompt.trim()}
              style={{ gap: 7, height: 42, padding: "0 18px" }}
            >
              {nlpLoading ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}
              Simulate
            </button>
          </form>
          <div className="nlp-prompts">
            <span className="nlp-prompts__label">Quick scenarios:</span>
            <div className="nlp-prompts__list">
              <button
                type="button"
                className="nlp-prompt-btn"
                onClick={() => handleNlpSubmit("What if my paycheck is delayed 3 days?")}
              >
                Paycheck delayed 3 days
              </button>
              <button
                type="button"
                className="nlp-prompt-btn"
                onClick={() => handleNlpSubmit(`What if ${primaryBill?.name ?? "rent"} moves 4 days later?`)}
              >
                Shift {titleCase(primaryBill?.name ?? "rent")} 4 days later
              </button>
              <button
                type="button"
                className="nlp-prompt-btn"
                onClick={() => handleNlpSubmit("What if I earn a $300 side gig bonus?")}
              >
                +$300 side income
              </button>
              <button
                type="button"
                className="nlp-prompt-btn"
                onClick={() => handleNlpSubmit("What if I skip discretionary spending this week?")}
              >
                Pause discretionary spend
              </button>
            </div>
          </div>
          {nlpExplanation && (
            <div className="nlp-status-row">
              <Check size={14} />
              <span>{nlpExplanation}</span>
            </div>
          )}
        </article>

        <article className="surface simulator simulator--hero">
          <div className="simulator__head">
            <Cpu size={16} className="text-safe" />
            <div>
              <h3>Choose a fix to test</h3>
              <p>Select any scenario to see how it reshapes your cash line across 1,000 simulations.</p>
            </div>
          </div>
          <div className="lever-grid">
            {([
              ["shift", "Shift largest bill by 3 days", `Move ${titleCase(primaryBill?.name ?? "the bill")} past the low cash date`, CalendarClock],
              ["transfer", `Move ${money(recommendedPlan?.amount || 150)} from savings`, "Add a small backup buffer to your checking balance", CircleDollarSign],
              ["spending", "Pause one flexible expense", `Temporarily hold ${titleCase(flexibleStream?.name ?? "extra spending")}`, WalletCards],
              ["delay", "Test a 2-day payday delay", "Stress test what happens if your deposit arrives late", AlertTriangle],
            ] as const).map(([id, title, description, Icon]) => (
              <button
                key={id}
                type="button"
                className={`lever-card ${scenarioChoice === id ? "is-selected" : ""} ${id === "delay" ? "is-stress" : ""}`}
                onClick={() => setScenarioChoice(id)}
              >
                <div className="lever-card__top">
                  <span className="lever-card__icon"><Icon size={18} /></span>
                  <span className="lever-card__badge">{scenarioChoice === id ? "Selected" : id === "shift" ? "Timing fix" : id === "transfer" ? "Cash fix" : id === "spending" ? "Spending cut" : "Stress test"}</span>
                </div>
                <strong>{title}</strong>
                <p>{description}</p>
              </button>
            ))}
          </div>
          <div className="simulator__actions">
            <button
              className="button button--primary"
              type="button"
              disabled={scenarioState === "loading"}
              onClick={runScenario}
            >
              {scenarioState === "loading" ? <LoaderCircle className="spin" size={16} /> : <CircleDollarSign size={16} />}
              {scenarioState === "loading" ? "Running 1,000 simulations..." : "Run simulation"}
            </button>
            {scenarioError && <p className="error-copy" role="alert">{scenarioError}</p>}
          </div>
        </article>

        {scenarioResult && (
          <article className={`surface simulation-result simulation-result--live ${peakRisk(scenarioResult) < risk ? "is-improved" : "is-worse"}`}>
            <div className="simulation-result__header">
              <div>
                <span>Simulated Forecast Result</span>
                <h3>{peakRisk(scenarioResult) <= 0.05 ? "Scenario brings risk into the safe zone" : "Scenario still leaves remaining risk"}</h3>
              </div>
              <div className="result-summary">
                <div className="result-pill">
                  <span>Original risk</span>
                  <strong className="text-risk">{percent(risk)}</strong>
                </div>
                <div className="result-pill-arrow"><ArrowRight size={14} /></div>
                <div className="result-pill">
                  <span>New risk</span>
                  <strong className={peakRisk(scenarioResult) <= 0.05 ? "text-safe" : "text-risk"}>
                    {percent(peakRisk(scenarioResult))}
                  </strong>
                </div>
                <div className="result-pill is-balance">
                  <span>Projected low</span>
                  <strong>{money(minimumBalance(scenarioResult), 2)}</strong>
                </div>
              </div>
            </div>
            <CashflowChart data={scenarioResult} compact showConfidence={false} label="Scenario forecast result" />
          </article>
        )}
        </ViewGate>
        {actions("risk", "plan", "See the recommended plan")}
      </section>}
      {view === "plan" && <section className="scene scene--wide">
        {(() => {
          const planDone = getAnimState("plan") === "done";
          return (
            <SceneHeading
              badge={planDone ? <><ShieldCheck size={14} /> Recommended step</> : <><Cpu size={14} /> Quick Fix Finder</>}
              badgeType="safe"
              title={planDone ? `${actionTitle(recommendedPlan)}.` : "Find the easiest fix to protect your balance."}
              subtitle={planDone ? (recommendedPlan ? `We tested ${data.decisionPlan?.candidateCount?.toLocaleString() ?? 0} different fixes. This simple step cuts your risk from ${percent(data.decisionPlan?.beforeRisk ?? risk)} down to ${percent(recommendedPlan.risk)} before ${dateLabel(lastSafeDate)}.` : "Your account is already safe, so no action is needed.") : "We compare different options like moving a bill due date or transferring money to find the simplest way to stay safe."}
            />
          );
        })()}
        <ViewGate viewKey="plan" data={data} animState={getAnimState("plan")} onStart={startAnim} onComplete={completeAnim}>
        <article className="surface recommendation recommendation--hero">
          <div className="recommendation__header">
            <div className="recommendation__tag">
              <ShieldCheck size={14} />
              <span>Recommended Action</span>
            </div>
            <h2>{actionTitle(recommendedPlan)}</h2>
            <p>Calculated to protect your checking account before the low cash date with minimum effort.</p>
          </div>
          <div className="metric-grid">
            <div className="metric-card">
              <span>Required amount</span>
              <strong>{recommendedPlan ? money(recommendedPlan.amount, 2) : "$0.00"}</strong>
              <small>Transfer or bill adjustment</small>
            </div>
            <div className="metric-card">
              <span>Review deadline</span>
              <strong>{dateLabel(lastSafeDate)}</strong>
              <small>Before largest bill hits</small>
            </div>
            <div className="metric-card">
              <span>Risk reduction</span>
              <strong className="text-safe">{percent(data.decisionPlan?.beforeRisk ?? risk)} to {percent(recommendedPlan?.risk ?? 0)}</strong>
              <small>Brings risk under 5% target</small>
            </div>
            <div className="metric-card">
              <span>Potential fees avoided</span>
              <strong className="text-safe">{money(cascade?.totalFees ?? 35, 2)}</strong>
              <small>Projected bank penalties</small>
            </div>
          </div>
          <div style={{ marginTop: 20, paddingTop: 18, borderTop: "1px solid var(--line)", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div>
              <strong style={{ fontSize: "0.86rem", display: "block" }}>Need to negotiate this bill?</strong>
              <small style={{ color: "var(--muted)", fontSize: "0.75rem" }}>Draft an AI negotiation letter grounded with exact dates and amounts.</small>
            </div>
            <button
              type="button"
              className="button button--primary"
              onClick={() => openHardshipModal("extension")}
              style={{ gap: 8, padding: "9px 16px", fontSize: "0.82rem" }}
            >
              <FileText size={15} />
              Draft negotiation letter
            </button>
          </div>
        </article>
        <article className="surface rescue-preview rescue-preview--hero">
          <div className="rescue-preview__head">
            <div>
              <span>Trajectory Comparison</span>
              <h3>Original Forecast vs Rescued Forecast</h3>
            </div>
            <div className="rescue-preview__legend">
              <span className="legend-item"><i className="is-before" /> Without fix ({percent(risk)} risk)</span>
              <span className="legend-item"><i className="is-safe" /> With fix ({percent(peakRisk(rescuedForecast))} risk)</span>
            </div>
          </div>
          <CashflowChart data={data} comparisonData={rescuedForecast} showConfidence={false} mode="comparison" label="Original forecast compared with the recommended plan" />
        </article>

        {(data.decisionPlan?.alternatives?.length ?? 0) > 0 && (
          <article className="surface alternatives-panel">
            <div className="alternatives-panel__head">
              <h3>Other Options Evaluated ({data.decisionPlan?.alternatives?.length ?? 0})</h3>
              <span>Ranked by convenience and safety</span>
            </div>
            <div className="alternatives-grid">
              {data.decisionPlan?.alternatives?.slice(0, 3).map((option, index) => (
                <div className="alternative-card" key={`${option.type}-${index}`}>
                  <div className="alternative-card__top">
                    <strong>{actionTitle(option)}</strong>
                    <span className="status-badge status-badge--pending">{percent(option.risk, 1)} risk</span>
                  </div>
                  <p>{option.explanation}</p>
                </div>
              ))}
            </div>
          </article>
        )}
        </ViewGate>
        {actions("test", "spend", "Set a safe spending plan")}
      </section>}
      {view === "spend" && <section className="scene scene--wide">
        {(() => {
          const spendDone = getAnimState("spend") === "done";
          return (
            <SceneHeading
              badge={spendDone ? <><ShieldCheck size={14} /> Safe weekly budget</> : <><CircleDollarSign size={14} /> Safe Spending Calculator</>}
              badgeType="safe"
              title={spendDone ? `${money(safeWeekly)} is safe to spend this week.` : "Calculate your safe weekly spending limit."}
              subtitle={spendDone ? `That is about ${money(safeWeekly / 7, 2)} per day, after covering ${money(budget.totalFixed)} in bills and keeping ${money(budget.recommendedBuffer)} as a cushion.` : "We set aside money for your upcoming bills and a safety cushion first, then tell you what is safe to spend each week."}
            />
          );
        })()}
        <ViewGate viewKey="spend" data={data} animState={getAnimState("spend")} onStart={startAnim} onComplete={completeAnim}>
        <article className="surface allowance-hero">
          <header className="allowance-hero__head">
            <span>Safe weekly spending limit</span>
            <h1>{money(safeWeekly, 2)}</h1>
            <p>About {money(safeWeekly / 7, 2)} per day, after setting aside money for all bills and a safety cushion.</p>
          </header>
          <div className="allowance-equation">
            <div className="allowance-equation__item">
              <span>Monthly income</span>
              <strong className="text-safe">+{money(budget.totalMonthlyIncome)}</strong>
            </div>
            <div className="allowance-equation__op">-</div>
            <div className="allowance-equation__item">
              <span>Scheduled bills</span>
              <strong className="text-ink">-{money(budget.totalFixed)}</strong>
            </div>
            <div className="allowance-equation__op">-</div>
            <div className="allowance-equation__item">
              <span>Safety cushion</span>
              <strong className="text-ink">-{money(budget.recommendedBuffer)}</strong>
            </div>
            <div className="allowance-equation__op">=</div>
            <div className="allowance-equation__item is-result">
              <span>Safe for the month</span>
              <strong className="text-safe">{money(budget.totalDiscretionaryMonthlyRate)}</strong>
            </div>
          </div>
        </article>

        <article className="surface spending-categories">
          <div className="spending-categories__head">
            <div>
              <h3>Weekly Spending by Category</h3>
              <p>Suggested limits for everyday purchases</p>
            </div>
          </div>
          <div className="spending-categories__grid">
            {budget.discretionary.map((line) => (
              <div key={line.streamName} className="spending-category-card">
                <div className="spending-category-card__top">
                  <strong>{line.label}</strong>
                  <span className="category-amount text-safe">{money(line.monthlyRate / 4.33, 2)} / wk</span>
                </div>
                <div className="spending-category-card__meta">
                  <small>{money(line.monthlyRate, 2)} per month</small>
                </div>
              </div>
            ))}
          </div>
          <div className="spending-categories__note">
            <ShieldCheck size={16} className="text-safe" />
            <p>Spending within these targets keeps your account balance safe even if everyday spending fluctuates.</p>
          </div>
        </article>
        </ViewGate>
        <div className="scene-actions"><div><button className="button button--text" type="button" onClick={() => go("plan")}>Fix</button></div></div>
      </section>}
      {view === "account" && <section className="scene scene--wide">
        <header className="scene-heading">
          <span className="status-badge status-badge--safe"><ShieldCheck size={14} /> Read-only connection</span>
          <h1>Your connected bank data.</h1>
          <p>{data.transparency?.transactionCount ?? transactions.length} transactions, {data.streams?.length ?? 0} recurring patterns, and {pendingTransactions.length} pending charges. Overcast reads all of this to forecast what is coming next.</p>
        </header>
        <article className="surface bank-health">
          <div className="bank-health__account">
            <span className="icon-tile"><Landmark size={20} /></span>
            <div>
              <h2>{data.accountName ?? "Plaid checking"}</h2>
              <p>Primary forecasting account</p>
            </div>
            <span className="status-badge status-badge--safe"><i /> {connection?.connected ? "Healthy · Sync active" : "Connection check"}</span>
          </div>
          <div className="bank-health__metrics">
            <div>
              <span>Connection</span>
              <strong>Plaid</strong>
              <small>Read-only data exchange</small>
            </div>
            <div>
              <span>Last sync</span>
              <strong>{timeAgo(connection?.lastSyncedAt ?? data.transparency?.lastSyncedAt).replace("Synced ", "")}</strong>
              <small>{connection?.webhookConfigured ? "Automatic updates active" : "Manual refresh available"}</small>
            </div>
          </div>
          <div className="bank-health__control">
            <BankConnectionControl />
          </div>
        </article>

        {auditData && (
          <article className="surface ai-audit-card">
            <div className="ai-audit-card__head">
              <span><Layers size={14} /> Account Intelligence · Subscription Audit</span>
              <small className="status-badge status-badge--safe">Audit Live</small>
            </div>
            <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: "0.83rem", lineHeight: 1.5 }}>
              {auditData.aiSummary}
            </p>
            <div className="ai-audit-grid">
              <button
                type="button"
                className={`ai-audit-stat ${expandedAuditSection === "subscriptions" ? "is-active" : ""}`}
                onClick={() => setExpandedAuditSection(prev => prev === "subscriptions" ? null : "subscriptions")}
                aria-expanded={expandedAuditSection === "subscriptions"}
              >
                <div className="ai-audit-stat__top">
                  <span>Active Subscriptions</span>
                  <ChevronDown size={14} className={`ai-audit-stat__chevron ${expandedAuditSection === "subscriptions" ? "is-expanded" : ""}`} />
                </div>
                <strong>{auditData.subscriptions.length} tracked</strong>
                <small className="ai-audit-stat__hint">
                  {expandedAuditSection === "subscriptions" ? "Hide details" : "View tracked items"}
                </small>
              </button>

              <button
                type="button"
                className={`ai-audit-stat ${expandedAuditSection === "recurring" ? "is-active" : ""}`}
                onClick={() => setExpandedAuditSection(prev => prev === "recurring" ? null : "recurring")}
                aria-expanded={expandedAuditSection === "recurring"}
              >
                <div className="ai-audit-stat__top">
                  <span>Monthly Recurring</span>
                  <ChevronDown size={14} className={`ai-audit-stat__chevron ${expandedAuditSection === "recurring" ? "is-expanded" : ""}`} />
                </div>
                <strong className="text-safe">${auditData.monthlySubscriptionTotal.toFixed(2)}/mo</strong>
                <small className="ai-audit-stat__hint">
                  {expandedAuditSection === "recurring" ? "Hide details" : "View breakdown"}
                </small>
              </button>

              <button
                type="button"
                className={`ai-audit-stat ${expandedAuditSection === "anomalies" ? "is-active" : ""}`}
                onClick={() => setExpandedAuditSection(prev => prev === "anomalies" ? null : "anomalies")}
                aria-expanded={expandedAuditSection === "anomalies"}
              >
                <div className="ai-audit-stat__top">
                  <span>Price Health</span>
                  <ChevronDown size={14} className={`ai-audit-stat__chevron ${expandedAuditSection === "anomalies" ? "is-expanded" : ""}`} />
                </div>
                <strong>{auditData.anomalies.length === 0 ? "100% Stable" : `${auditData.anomalies.length} Changes`}</strong>
                <small className="ai-audit-stat__hint">
                  {expandedAuditSection === "anomalies" ? "Hide details" : "View anomaly log"}
                </small>
              </button>
            </div>

            {/* Expandable Details Drawer */}
            <AnimatePresence>
              {expandedAuditSection && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.18 }}
                  className="ai-audit-drawer"
                >
                  {expandedAuditSection === "subscriptions" && (
                    <div className="ai-audit-detail">
                      <div className="ai-audit-detail__head">
                        <h4>Tracked Subscriptions ({auditData.subscriptions.length})</h4>
                        <span className="status-badge status-badge--safe">Auto-Categorized</span>
                      </div>
                      {auditData.subscriptions.length === 0 ? (
                        <p className="ai-audit-empty">No recurring digital subscriptions detected in transaction history.</p>
                      ) : (
                        <div className="ai-audit-list">
                          {auditData.subscriptions.map((s, idx) => (
                            <div key={idx} className="ai-audit-item">
                              <div className="ai-audit-item__info">
                                <strong>{s.name}</strong>
                                <span>{s.category} · {s.cadence}</span>
                              </div>
                              <span className="ai-audit-item__amount">${s.amount.toFixed(2)}/mo</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {expandedAuditSection === "recurring" && (
                    <div className="ai-audit-detail">
                      <div className="ai-audit-detail__head">
                        <h4>Monthly Commitment Breakdown</h4>
                        <span className="status-badge status-badge--safe">${auditData.monthlySubscriptionTotal.toFixed(2)} / month</span>
                      </div>
                      <div className="ai-audit-list">
                        {auditData.subscriptions.map((s, idx) => {
                          const pct = auditData.monthlySubscriptionTotal > 0
                            ? Math.round((s.amount / auditData.monthlySubscriptionTotal) * 100)
                            : 0;
                          return (
                            <div key={idx} className="ai-audit-item">
                              <div className="ai-audit-item__info">
                                <strong>{s.name}</strong>
                                <span className="ai-audit-bar-wrap">
                                  <span className="ai-audit-bar" style={{ width: `${pct}%` }} />
                                  {pct}% of monthly subscription burn
                                </span>
                              </div>
                              <span className="ai-audit-item__amount">${s.amount.toFixed(2)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {expandedAuditSection === "anomalies" && (
                    <div className="ai-audit-detail">
                      <div className="ai-audit-detail__head">
                        <h4>Price Changes & Billing Anomalies</h4>
                        <span className={`status-badge ${auditData.anomalies.length > 0 ? "status-badge--risk" : "status-badge--safe"}`}>
                          {auditData.anomalies.length === 0 ? "All Stable" : `${auditData.anomalies.length} Flagged`}
                        </span>
                      </div>
                      {auditData.anomalies.length === 0 ? (
                        <div className="ai-audit-clean">
                          <Check size={16} className="text-safe" />
                          <span>All recurring merchants have maintained 100% price consistency across audited cycles.</span>
                        </div>
                      ) : (
                        <div className="ai-audit-list">
                          {auditData.anomalies.map((a, idx) => (
                            <div key={idx} className="ai-audit-item ai-audit-item--anomaly">
                              <div className="ai-audit-item__info">
                                <strong className="text-risk">{a.merchant}</strong>
                                <span>{a.note}</span>
                              </div>
                              <span className="status-badge status-badge--risk">Price Increase</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </article>
        )}

        <article className="surface ledger">
          <div className="ledger-summary">
            <div>
              <span>Transactions indexed</span>
              <strong>{data.transparency?.transactionCount ?? transactions.length}</strong>
            </div>
            <div>
              <span>Pending items</span>
              <strong>{data.risk?.pendingTransactionCount ?? pendingTransactions.length}</strong>
            </div>
            <div>
              <span>Active streams tracked</span>
              <strong className="text-safe">{data.streams?.length ?? 0} streams</strong>
            </div>
          </div>
          {activityState === "loading" && <p className="loading-row"><LoaderCircle className="spin" />Loading connected activity</p>}
          {activityState === "error" && <p className="error-copy" role="alert">Activity could not be loaded. Refresh the bank connection and try again.</p>}
          <div className="ledger-filters" role="tablist" aria-label="Transaction category filters">
            <button
              type="button"
              className={`ledger-filter-pill ${ledgerFilter === "all" ? "is-active" : ""}`}
              onClick={() => setLedgerFilter("all")}
            >
              All ({transactions.length})
            </button>
            <button
              type="button"
              className={`ledger-filter-pill ${ledgerFilter === "income" ? "is-active" : ""}`}
              onClick={() => setLedgerFilter("income")}
            >
              Income ({transactions.filter(isIncomeTx).length})
            </button>
            <button
              type="button"
              className={`ledger-filter-pill ${ledgerFilter === "bills" ? "is-active" : ""}`}
              onClick={() => setLedgerFilter("bills")}
            >
              Recurring Bills ({transactions.filter((t) => !isIncomeTx(t) && isBillTx(t)).length})
            </button>
            <button
              type="button"
              className={`ledger-filter-pill ${ledgerFilter === "discretionary" ? "is-active" : ""}`}
              onClick={() => setLedgerFilter("discretionary")}
            >
              Discretionary ({transactions.filter((t) => !isIncomeTx(t) && !isBillTx(t)).length})
            </button>
          </div>
          <div className="ledger-table" role="table" aria-label="Connected account activity">
            <div className="ledger-table__head" role="row">
              <span>Date</span>
              <span>Merchant and category</span>
              <span>Status</span>
              <span>Amount</span>
            </div>
            {filteredTransactions.slice(0, 40).map((transaction) => (
              <div className="ledger-row" role="row" key={transaction.id}>
                <span>{dateLabel(transaction.authorized_date ?? transaction.posted_date, { month: "short", day: "numeric" })}</span>
                <div>
                  <strong>{transaction.merchant_name ?? transaction.description}</strong>
                  <small>{titleCase(transaction.primary_category ?? transaction.detailed_category ?? "Uncategorized")}</small>
                </div>
                <span className={`status-badge ${transaction.pending ? "status-badge--pending" : "status-badge--safe"}`}>
                  {transaction.pending ? "Pending" : "Posted"}
                </span>
                <b className={Number(transaction.amount) < 0 ? "text-safe" : ""}>
                  {Number(transaction.amount) < 0 ? "+" : "-"}{money(Math.abs(Number(transaction.amount)), 2)}
                </b>
              </div>
            ))}
          </div>
          {activityState === "ready" && filteredTransactions.length === 0 && (
            <p className="empty-copy">No transactions found for this category filter.</p>
          )}
        </article>
        <div className="trust-grid">
          <article className="surface">
            <LockKeyhole size={20} className="text-safe" />
            <h2>Read-only channel</h2>
            <p>Overcast cannot execute transfers or contact a biller without your action.</p>
          </article>
          <article className="surface">
            <ShieldCheck size={20} className="text-safe" />
            <h2>Data stays scoped</h2>
            <p>Only the connected account data needed for the forecast is used.</p>
          </article>
          <article className="surface">
            <Activity size={20} className="text-safe" />
            <h2>Activity informs the forecast</h2>
            <p>Pending and posted entries remain visible for verification.</p>
          </article>
        </div>
        {actions("account", "position", "See what Overcast finds")}
      </section>}
    </div></main>
    <footer className="app-footer"><span>Overcast · Clear, simple cash flow forecasts</span></footer>

    <AnimatePresence>
      {hardshipOpen && (
        <motion.div
          className="hardship-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={(e) => { if (e.target === e.currentTarget) setHardshipOpen(false); }}
        >
          <motion.div
            className="hardship-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="hardship-title"
            initial={{ scale: 0.95, opacity: 0, y: 16 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 16 }}
          >
            <div className="hardship-dialog__head">
              <div>
                <span>Forensic Action Draft · Verified Facts</span>
                <h2 id="hardship-title">Bill Due-Date Negotiation Letter</h2>
              </div>
              <button
                type="button"
                className="hardship-dialog__close"
                onClick={() => setHardshipOpen(false)}
                aria-label="Close dialog"
              >
                <X size={18} />
              </button>
            </div>
            <div className="hardship-dialog__body">
              <p>
                Drafted using Gemini with validated account facts. Dollar amounts, due dates, and recipient names are mathematically locked from your forecast.
              </p>

              <div className="strategy-tabs" role="tablist" aria-label="Negotiation strategies">
                <button
                  type="button"
                  className={`strategy-tab ${hardshipStrategy === "extension" ? "is-active" : ""}`}
                  onClick={() => openHardshipModal("extension")}
                  disabled={hardshipLoading}
                >
                  <strong>1. Grace Period</strong>
                  <small>4-day delay</small>
                </button>
                <button
                  type="button"
                  className={`strategy-tab ${hardshipStrategy === "split" ? "is-active" : ""}`}
                  onClick={() => openHardshipModal("split")}
                  disabled={hardshipLoading}
                >
                  <strong>2. 50/50 Split</strong>
                  <small>2 installments</small>
                </button>
                <button
                  type="button"
                  className={`strategy-tab ${hardshipStrategy === "waiver" ? "is-active" : ""}`}
                  onClick={() => openHardshipModal("waiver")}
                  disabled={hardshipLoading}
                >
                  <strong>3. Fee Waiver</strong>
                  <small>Waive late penalty</small>
                </button>
              </div>

              {hardshipLoading && (
                <div className="oc-loading" style={{ padding: "40px 0", justifyContent: "center" }}>
                  <span /> Drafting personalized request with Gemini...
                </div>
              )}

              {hardshipError && (
                <div className="error-copy" style={{ marginTop: 16 }} role="alert">
                  {hardshipError}
                </div>
              )}

              {hardshipData?.letter && (
                <>
                  <div className="hardship-letter">
                    {hardshipData.letter.map((paragraph, i) => (
                      <p key={i}>{paragraph}</p>
                    ))}
                  </div>
                  <div className="hardship-disclosure">
                    <ShieldCheck size={16} />
                    <span>Deterministic financial guardrails: Recipient name, due date, and amount due are computed server-side to prevent hallucinations.</span>
                  </div>
                  <div className="hardship-dialog__actions">
                    <button
                      type="button"
                      className="button button--primary"
                      onClick={handleCopyLetter}
                      style={{ gap: 8 }}
                    >
                      {copiedToast ? <Check size={15} /> : <Copy size={15} />}
                      {copiedToast ? "Copied to clipboard!" : "Copy letter"}
                    </button>
                    <button
                      type="button"
                      className="button button--secondary"
                      onClick={handleDownloadLetter}
                      style={{ gap: 8 }}
                    >
                      <Download size={15} />
                      Download .txt
                    </button>
                  </div>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  </>;
}
