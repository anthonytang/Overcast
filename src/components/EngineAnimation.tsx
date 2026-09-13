"use client";

/**
 * EngineAnimation v3: ML & Signal-Processing Canvas Visualizations
 *
 * position → ACF autocorrelation + impulse-train decomposition
 * risk     → Multi-stream superposition: B(d) = B₀ + Σ sign(i)·aᵢ·𝟙[...]
 * test     → Monte Carlo stochastic path simulation & confidence fan
 * plan     → Gradient descent optimizer on 2D risk surface
 * spend    → Variance-based buffer derivation & weekly allowance waterfall
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { ForecastResult } from "@/lib/forecast";
import { computeAutoBudget } from "@/lib/budget";

export type AnimationScene = "position" | "risk" | "test" | "plan" | "spend";

// ─── Timing ─────────────────────────────────────────────────────────────────
// 16s gives ~4s per step, allowing users and judges ample time to comfortably read and watch
const MAIN_MS    = 16000;
const OUTRO_MS   = 2400;
const FADE_IN_MS = 750;
const STEP_COUNT = 4;

// ─── Palettes ────────────────────────────────────────────────────────────────
const D = {
  bg:      "#1d332e",
  card:    "#263f38",
  border:  "#4b665d",
  safe:    "#a8d7ae", safeDim: "rgba(168,215,174,0.18)", safeMid: "rgba(168,215,174,0.55)",
  risk:    "#f0a38d", riskDim: "rgba(240,163,141,0.15)", riskMid: "rgba(240,163,141,0.52)",
  blue:    "#e0cb83", blueDim: "rgba(224,203,131,0.14)", blueMid: "rgba(224,203,131,0.48)",
  yellow:  "#e7bd76", purple: "#d1bba3", cyan: "#9bc9b6",
  ink:     "rgba(255,253,250,0.9)", muted: "rgba(255,253,250,0.56)", faint: "#3a5149",
  axis:    "rgba(255,253,250,0.22)",
};

const L = {
  bg:       "#f5f3ee",
  surface:  "#fffdfa",
  card:     "#fffdfa",
  border:   "#d9d8cf",
  line:     "#d9d8cf",
  ink:      "#182b2b",
  inkDim:   "#4b5a58",
  muted:    "#6c7672",
  faint:    "#c8c7bd",
  blue:     "#88762d",
  blueDim:  "rgba(136,118,45,0.12)",
  safe:     "#176b55",
  safeDim:  "rgba(23,107,85,0.14)",
  risk:     "#a84242",
  riskDim:  "rgba(168,66,66,0.14)",
  yellow:   "#996619",
  yellowDim:"rgba(153,102,25,0.14)",
  purple:   "#806d57",
  cyan:     "#427569",
};

// ─── Math helpers ────────────────────────────────────────────────────────────
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function easeOut(t: number) { return 1 - Math.pow(1 - t, 3); }
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
function smooth(e0: number, e1: number, x: number) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
function makeRng(seed: number) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
}
function lerpHex(a: string, b: string, t: number): string {
  const h = (s: string) => [parseInt(s.slice(1,3),16), parseInt(s.slice(3,5),16), parseInt(s.slice(5,7),16)];
  const [ar,ag,ab] = h(a), [br,bg2,bb] = h(b);
  return `#${Math.round(lerp(ar,br,t)).toString(16).padStart(2,"0")}${Math.round(lerp(ag,bg2,t)).toString(16).padStart(2,"0")}${Math.round(lerp(ab,bb,t)).toString(16).padStart(2,"0")}`;
}
function fmtMoney(n: number) { const s=Math.abs(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}); return n<0?`-$${s}`:`$${s}`; }
function fmtPct(n: number) { return `${(n*100).toFixed(0)}%`; }
function fmtDate(value?: string | null) {
  if (!value) return "None forecast";
  const date = new Date(value.includes("T") ? value : `${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}
function subtitles(scene: AnimationScene, ex: Extracted): string[] {
  return getTickerMessages(scene, ex);
}

// ─── Data extraction ──────────────────────────────────────────────────────────
interface Extracted {
  streams: NonNullable<ForecastResult["streams"]>;
  series: ForecastResult["series"];
  startBal: number;
  pendingGap: number;
  availableLiquidity: number;
  buffer: number;
  dangerDay: ForecastResult["dangerDays"][0] | null;
  peakRisk: number;
  candidateCount: number;
  recommended: NonNullable<NonNullable<ForecastResult["decisionPlan"]>["recommended"]> | null;
  beforeRisk: number;
  monthlyIncome: number;
  monthlyFixed: number;
  safeWeekly: number;
  sampleCount: number;
}

const DEMO_STREAMS = [
  { name:"ACME PAYROLL",    cadenceDays:14, amount:1200,  isIncome:true,  isEstimated:false, firstDay:8  },
  { name:"SUNNYSIDE RENT",  cadenceDays:30, amount:1100,  isIncome:false, isEstimated:false, firstDay:3  },
  { name:"CITY ELECTRIC",   cadenceDays:30, amount:140,   isIncome:false, isEstimated:false, firstDay:12 },
  { name:"GROCERY MART",    cadenceDays:7,  amount:85,    isIncome:false, isEstimated:false, firstDay:2  },
  { name:"STREAMFLIX",      cadenceDays:30, amount:15.99, isIncome:false, isEstimated:false, firstDay:14 },
  { name:"MUSICWAVE",       cadenceDays:30, amount:9.99,  isIncome:false, isEstimated:false, firstDay:14 },
];

function extract(scene: AnimationScene, data?: ForecastResult): Extracted {
  const streams = data?.streams?.length ? data.streams : DEMO_STREAMS as typeof DEMO_STREAMS;
  const series  = data?.series ?? [];
  const startBal = data?.startingBalance ?? 500;
  const pendingGap = Math.max(0, data?.risk?.pendingBalanceGap ?? 0);
  const availableLiquidity = startBal - pendingGap;
  const dangerDay = data?.dangerDays?.[0] ?? null;
  const peakRisk = Math.max(0, ...series.map(d => d.overdraftProbability ?? 0));
  const candidateCount = data?.decisionPlan?.candidateCount ?? 24;
  const recommended = data?.decisionPlan?.recommended ?? null;
  const beforeRisk = data?.decisionPlan?.beforeRisk ?? peakRisk;
  const income = streams.filter(s => s.isIncome);
  const bills  = streams.filter(s => !s.isIncome && !s.isEstimated);
  const rawMonthlyIncome = income.reduce((a,s)=>a+s.amount*(30/s.cadenceDays),0);
  const rawMonthlyFixed  = bills.reduce ((a,s)=>a+s.amount*(30/s.cadenceDays),0);
  const budget = data ? computeAutoBudget(data, streams) : null;
  const monthlyIncome = budget ? budget.totalMonthlyIncome : rawMonthlyIncome;
  const monthlyFixed  = budget ? budget.totalFixed : rawMonthlyFixed;
  const buffer = budget ? budget.recommendedBuffer : 200;
  const safeWeekly = budget ? Math.max(0, budget.totalDiscretionaryMonthlyRate / 4.33) : Math.max(0, (monthlyIncome - monthlyFixed - 200) / 4.33);
  return {
    streams: streams as typeof DEMO_STREAMS, series, startBal, pendingGap, availableLiquidity,
    buffer, dangerDay, peakRisk, candidateCount, recommended, beforeRisk,
    monthlyIncome, monthlyFixed, safeWeekly, sampleCount: data?.risk?.simulationCount ?? 1000
  };
}

// Helper to clean bank merchant descriptions into polished readable names
function cleanStreamName(name: string, isIncome: boolean): string {
  const upper = name.toUpperCase();
  if (upper.includes("PAYROLL") || upper.includes("ACME") || upper.includes("SALARY") || upper.includes("EMPLOYER") || (isIncome && !upper.includes("REFUND"))) {
    return "PAYROLL";
  }
  if (upper.includes("RENT") || upper.includes("SUNNYSIDE") || upper.includes("APARTMENT") || upper.includes("MORTGAGE") || upper.includes("HOUSING")) {
    return "RENT / HOUSING";
  }
  if (upper.includes("ELECTRIC") || upper.includes("UTILITY") || upper.includes("ENERGY") || upper.includes("WATER") || upper.includes("POWER")) {
    return "UTILITIES";
  }
  if (upper.includes("NETFLIX") || upper.includes("SPOTIFY") || upper.includes("STREAM") || upper.includes("MUSIC") || upper.includes("APPLE") || upper.includes("PRIME") || upper.includes("HULU")) {
    return "SUBSCRIPTIONS";
  }
  if (upper.includes("GROCERY") || upper.includes("MART") || upper.includes("MARKET") || upper.includes("SAFEWAY") || upper.includes("TRADER") || upper.includes("WHOLE")) {
    return "GROCERIES";
  }
  if (upper.includes("UBER") || upper.includes("LYFT")) {
    return "TRANSIT";
  }
  const cleaned = name.replace(/\b\d{4,}\b/g, "").replace(/\b[A-Z]{2}\b$/g, "").replace(/[^a-zA-Z0-9\s&/-]/g, "").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 14).toUpperCase() : (isIncome ? "INCOME" : "FIXED BILL");
}

// ─── Step-by-Step Narration (4 deliberate steps, ~4s each) ────────────────────
interface NarrationStep {
  step: string;
  title: string;
  detail: string;
}

function getNarrationStep(scene: AnimationScene, ex: Extracted, t: number): NarrationStep | null {
  const nStr = ex.streams.length || 6;
  const { dangerDay, peakRisk, candidateCount, recommended, safeWeekly, sampleCount } = ex;

  switch (scene) {
    case "position":
      if (t < 0.28)
        return { step: "1 OF 4", title: "Scanning bank activity", detail: "Looking at 60 days of past deposits and daily spending" };
      if (t < 0.54)
        return { step: "2 OF 4", title: "Finding regular cycles", detail: "Detecting repeating 14-day paydays and 30-day billing habits" };
      if (t < 0.78)
        return { step: "3 OF 4", title: "Filtering out one-off expenses", detail: "Separating random daily purchases from regular bills" };
      return { step: "4 OF 4", title: "Regular streams locked in", detail: `${nStr} regular income and bill streams confirmed with amounts` };

    case "risk":
      if (t < 0.28)
        return { step: "1 OF 4", title: "Projecting schedule forward", detail: "Mapping upcoming paychecks and expected bills over 30 days" };
      if (t < 0.54)
        return { step: "2 OF 4", title: "Adding income and subtracting bills", detail: "Calculating your expected balance for every upcoming day" };
      if (t < 0.78)
        return { step: "3 OF 4", title: "Testing against the $0 line", detail: "Checking if upcoming expenses exceed available cash" };
      return {
        step: "4 OF 4",
        title: dangerDay ? "Low balance alert detected" : "Safe balance forecast",
        detail: dangerDay
          ? `Projected drop on ${fmtDate(dangerDay.date)} to ${fmtMoney(dangerDay.balance)}`
          : "Balance stays comfortably above zero for the next 30 days",
      };

    case "test":
      if (t < 0.28)
        return { step: "1 OF 4", title: "Modeling spending ups and downs", detail: "Looking at past spending swings to account for surprises" };
      if (t < 0.54)
        return { step: "2 OF 4", title: `Simulating ${sampleCount.toLocaleString()} future cash paths`, detail: "Testing how different spending patterns affect your balance" };
      if (t < 0.78)
        return { step: "3 OF 4", title: "Counting safe vs tight outcomes", detail: "Separating safe paths (green) from overdraft risk (red)" };
      return {
        step: "4 OF 4",
        title: peakRisk > 0 ? "Starting risk level calculated" : "Safe cash flow verified",
        detail: peakRisk > 0
          ? `${fmtPct(peakRisk)} peak risk detected under volatile conditions`
          : "Over 99% of simulated paths stay safely above zero",
      };

    case "plan":
      if (t < 0.28)
        return { step: "1 OF 4", title: "Comparing fix options", detail: "Testing bill shifts, savings transfers, and spending trims" };
      if (t < 0.54)
        return { step: "2 OF 4", title: `Testing ${candidateCount} possible adjustments`, detail: "Checking how each change protects your future balance" };
      if (t < 0.78)
        return { step: "3 OF 4", title: "Picking the easiest step", detail: "Comparing the backup amount against how much risk it removes" };
      return {
        step: "4 OF 4",
        title: recommended ? "Best step found" : "Accounts balanced",
        detail: recommended
          ? `${fmtMoney(recommended.amount)} transfer successfully eliminates the overdraft risk`
          : "Your accounts are already positioned safely",
      };

    case "spend":
      if (t < 0.28)
        return { step: "1 OF 4", title: "Adding up monthly commitments", detail: `Securing ${fmtMoney(ex.monthlyFixed)} in fixed bills + safety cushion first` };
      if (t < 0.54)
        return { step: "2 OF 4", title: "Testing different daily spending amounts", detail: "Checking which daily spending speeds leave enough for bills" };
      if (t < 0.78)
        return { step: "3 OF 4", title: "Finding the highest safe limit", detail: "Picking the highest weekly amount that never dips below zero" };
      return {
        step: "4 OF 4",
        title: "Safe weekly limit set",
        detail: `${fmtMoney(safeWeekly)} / week keeps your balance safe all month`,
      };
  }
}

// ─── Ticker messages (10 items per scene, rotating smoothly) ─────────────────
function getTickerMessages(scene: AnimationScene, ex: Extracted): string[] {
  const nStr = ex.streams.length || 6;
  const { dangerDay, peakRisk, candidateCount, recommended, safeWeekly, sampleCount } = ex;

  switch (scene) {
    case "position": return [
      "Reading 60 days of transaction history…",
      "Finding regular spending patterns…",
      "Filtering out random everyday spending…",
      `✓ Cash flow mapped: ${nStr} streams confirmed`,
    ];
    case "risk": return [
      "Projecting paychecks and bills 30 days forward…",
      "Calculating daily projected cash balances…",
      "Checking for any dip near the $0 line…",
      dangerDay
        ? `Low balance alert: ${fmtDate(dangerDay.date)} drops to ${fmtMoney(dangerDay.balance)}`
        : "Balance remains safely above zero for 30 days",
    ];
    case "test": return [
      "Modeling day-to-day spending variability…",
      `Simulating ${sampleCount.toLocaleString()} future cash scenarios…`,
      "Evaluating safe vs tight trajectories…",
      peakRisk > 0 ? `Peak overdraft risk: ${fmtPct(peakRisk)}` : "All simulated paths remain safe",
    ];
    case "plan": return [
      "Comparing options across timing and cost…",
      `Evaluating ${candidateCount} possible adjustments…`,
      "Finding the path to lowest risk…",
      recommended
        ? `Best move: ${fmtMoney(recommended.amount)} transfer reduces risk to ${fmtPct(recommended.risk)}`
        : "Best move: accounts currently balanced",
    ];
    case "spend": return [
      "Testing a sample $50/day spending pace…",
      "Upcoming rent drops balance near the $0 line…",
      "Testing different weekly spending rates…",
      `✓ Safe weekly limit: ${fmtMoney(safeWeekly)} / week (bills covered)`,
    ];
  }
}

// ─── Result card ──────────────────────────────────────────────────────────────
interface ResultCard { label: string; main: string; sub: string; color: string; }
function resultCard(scene: AnimationScene, ex: Extracted): ResultCard {
  const { dangerDay, peakRisk, candidateCount, recommended, safeWeekly, streams, availableLiquidity, monthlyFixed, buffer, beforeRisk } = ex;
  const nI = streams.filter(s=>s.isIncome).length||1, nB = streams.filter(s=>!s.isIncome).length||5;
  switch (scene) {
    case "position": return {
      label: "STARTING CASH & REGULAR BILLS",
      main: `${fmtMoney(availableLiquidity)} available to plan`,
      sub: `${nI + nB} regular streams found · ${fmtMoney(monthlyFixed)}/mo bills`,
      color: L.blue
    };
    case "risk": return {
      label: "FIRST RISK DATE",
      main: dangerDay ? fmtDate(dangerDay.date) : "None forecast",
      sub: dangerDay ? `Projected balance reaches ${fmtMoney(dangerDay.balance)} (${fmtPct(peakRisk)} risk)` : "Balance stays above zero for the next 30 days",
      color: dangerDay ? L.risk : L.safe
    };
    case "test": return {
      label: "STARTING RISK LEVEL",
      main: `${fmtPct(peakRisk)} Overdraft Risk`,
      sub: `Across ${ex.sampleCount.toLocaleString()} simulations · Target ≤ 5%`,
      color: peakRisk > 0.3 ? L.risk : L.safe
    };
    case "plan": {
      const title = recommended
        ? recommended.type === "transfer" ? `Move ${fmtMoney(recommended.amount)} from savings`
          : recommended.type === "defer" ? `Shift ${cleanStreamName(recommended.streamName || "bill", false)} by ${recommended.days || 3}d`
          : recommended.type === "reduce_spending" ? `Trim spending by ${Math.round(recommended.percent || 15)}%`
          : `Move ${fmtMoney(recommended.amount)}`
        : "No action needed";
      return {
        label: "BEST FIX FOUND",
        main: title,
        sub: recommended ? `Cuts risk from ${fmtPct(beforeRisk)} down to ${fmtPct(recommended.risk)}` : `${candidateCount} fixes tested`,
        color: L.safe
      };
    }
    case "spend": return {
      label: "SAFE SPENDING LIMIT",
      main: `${fmtMoney(safeWeekly)} / week`,
      sub: `${fmtMoney(safeWeekly / 7)}/day after ${fmtMoney(monthlyFixed)} bills + ${fmtMoney(buffer)} cushion`,
      color: L.safe
    };
  }
}

// ─── Canvas helpers ───────────────────────────────────────────────────────────
function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, alpha: number) {
  ctx.save(); ctx.globalAlpha = alpha*0.055; ctx.strokeStyle = D.ink; ctx.lineWidth = 1;
  for (let i=0;i<=10;i++){const x=Math.round((w/10)*i);ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}
  for (let i=0;i<=6;i++){const y=Math.round((h/6)*i);ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
  ctx.restore();
}
function glowLine(ctx: CanvasRenderingContext2D, pts: Array<[number,number]>, color: string, width=2, blur=12, alpha=1) {
  if (pts.length<2) return;
  ctx.save(); ctx.globalAlpha=alpha; ctx.shadowColor=color; ctx.shadowBlur=blur;
  ctx.strokeStyle=color; ctx.lineWidth=width; ctx.lineJoin="round"; ctx.lineCap="round";
  ctx.beginPath(); ctx.moveTo(pts[0][0],pts[0][1]);
  for(let i=1;i<pts.length;i++) ctx.lineTo(pts[i][0],pts[i][1]);
  ctx.stroke(); ctx.restore();
}
function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, blur=8, alpha=1) {
  ctx.save(); ctx.globalAlpha=alpha; ctx.fillStyle=color; ctx.shadowColor=color; ctx.shadowBlur=blur;
  ctx.beginPath(); ctx.arc(Math.round(x),Math.round(y),r,0,Math.PI*2); ctx.fill(); ctx.restore();
}
const CANVAS_FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

function lbl(ctx: CanvasRenderingContext2D, text: string, x: number, y: number,
             size=11, color=D.ink, align: CanvasTextAlign="left", alpha=1) {
  if (alpha<=0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.font = `600 ${size}px ${CANVAS_FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(text, Math.round(x), Math.round(y));
  ctx.restore();
}

// A quiet workspace-style result panel closes the animation without turning the
// final state into a floating modal.
function drawResultCard(ctx: CanvasRenderingContext2D, w: number, h: number, outroT: number, card: ResultCard) {
  const t = clamp(smooth(0.12, 0.68, outroT), 0, 1);
  if (t <= 0) return;
  const inset = Math.max(30, Math.min(64, w * 0.06));
  const cardW = Math.max(280, Math.min(w - inset * 2, 760));
  const cardH = 132;
  const lx = Math.round(inset), ty = Math.round(Math.max(118, h * 0.27));
  ctx.save();
  ctx.globalAlpha = easeOut(t);
  ctx.fillStyle = L.surface; ctx.roundRect(lx, ty, cardW, cardH, 6); ctx.fill();
  ctx.strokeStyle = L.line; ctx.lineWidth = 1; ctx.roundRect(lx, ty, cardW, cardH, 6); ctx.stroke();
  ctx.fillStyle = card.color; ctx.fillRect(lx, ty, 3, cardH);

  ctx.font = `700 9px ${CANVAS_FONT}`; ctx.fillStyle = card.color; ctx.textAlign = "left";
  ctx.fillText(card.label, lx + 20, ty + 25);

  // Dynamically scale the decision so it always remains inside the panel.
  let ms = cardW > 560 ? 25 : 20;
  ctx.font = `700 ${ms}px ${CANVAS_FONT}`;
  while (ctx.measureText(card.main).width > cardW - 40 && ms > 14) {
    ms -= 2;
    ctx.font = `700 ${ms}px ${CANVAS_FONT}`;
  }
  ctx.fillStyle = L.ink; ctx.textAlign = "left";
  ctx.fillText(card.main, lx + 20, ty + 59);

  // Supporting evidence gets its own calm row below the decision.
  let subSize = 10.5;
  ctx.font = `500 ${subSize}px ${CANVAS_FONT}`;
  let subText = card.sub;
  while (ctx.measureText(subText).width > cardW - 40 && subSize > 9) {
    subSize -= 0.5;
    ctx.font = `500 ${subSize}px ${CANVAS_FONT}`;
  }
  if (ctx.measureText(subText).width > cardW - 40) {
    while (ctx.measureText(subText + "…").width > cardW - 40 && subText.length > 5) {
      subText = subText.slice(0, -1);
    }
    subText += "…";
  }
  ctx.fillStyle = L.muted;
  ctx.fillText(subText, lx + 20, ty + 84);

  ctx.strokeStyle = L.line; ctx.lineWidth = 1; ctx.beginPath();
  ctx.moveTo(lx + 20, ty + 99); ctx.lineTo(lx + cardW - 20, ty + 99); ctx.stroke();
  ctx.font = `600 8.5px ${CANVAS_FONT}`; ctx.fillStyle = L.safe; ctx.textAlign = "left";
  ctx.fillText("CALCULATION COMPLETE", lx + 20, ty + 116);
  if (cardW >= 420) {
    ctx.fillStyle = L.inkDim; ctx.textAlign = "right";
    ctx.fillText("Based on your connected account", lx + cardW - 20, ty + 116);
  }
  ctx.restore();
}

// Layout constants shared by all scenes
const HUD_H = 60;
const TOP_OFFSET = 76;


// ─── SCENE: POSITION: Regular Cash Streams Breakdown ─────────────────────────
function scenePosition(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, a: number, ex: Extracted) {
  const LPAD = 64, RPAD = 40, plotW = w - LPAD - RPAD;

  // Stretched 4-phase timing across 16s
  const rawT    = smooth(0.00, 0.28, t); // Phase 1: 60-day bank activity sweep
  const cadT    = smooth(0.24, 0.54, t); // Phase 2: Cadence rhythm spectrum (14d & 30d peaks)
  const filterT = smooth(0.50, 0.78, t); // Phase 3: One-off noise dims, repeating pulses glow
  const streamT = smooth(0.72, 1.00, t); // Phase 4: Clean decomposed stream lanes lock in

  // Pixel-perfect non-overlapping vertical tiers
  // Tier 1: 60-Day Transaction Flow Strip (y: 84 to 168, h: 84)
  const t1Top = TOP_OFFSET + 4;
  const t1H = 84;
  const t1MidY = t1Top + 40;

  // Tier 2: Cadence Detection Spectrum (y: 184 to 294, h: 110)
  const t2Top = t1Top + t1H + 16;
  const t2H = 110;
  const t2BaseY = t2Top + t2H - 18;

  // Tier 3: Isolated Cash Streams (y: 310 to 434)
  const t3Top = t2Top + t2H + 16;

  // ─── Tier 1: 60-Day Raw Bank Transaction Sweep ───
  if (rawT > 0) {
    lbl(ctx, "TRANSACTION FLOW (LAST 60 DAYS)", LPAD, t1Top + 8, 9, D.muted, "left", a * rawT);

    // Subtle status indicator for noise filtering
    if (filterT > 0) {
      const bAlpha = a * smooth(0.1, 0.6, filterT);
      lbl(ctx, "✓ RANDOM SPENDING NOISE FILTERED", w - RPAD, t1Top + 8, 8.5, D.blue, "right", bAlpha);
    } else {
      lbl(ctx, "Deposits (↑) & Daily Spending (↓)", w - RPAD, t1Top + 8, 8.5, D.muted, "right", a * rawT * 0.8);
    }

    // Baseline axis
    ctx.save();
    ctx.globalAlpha = a * rawT * 0.22;
    ctx.strokeStyle = D.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(LPAD, t1MidY);
    ctx.lineTo(w - RPAD, t1MidY);
    ctx.stroke();
    ctx.restore();

    // Day tick markers placed strictly below negative bars to eliminate any overlap
    for (const d of [0, 15, 30, 45, 60]) {
      const tx = LPAD + (d / 60) * plotW;
      lbl(ctx, `Day ${d}`, tx, t1Top + 74, 7.5, D.muted, "center", a * rawT * 0.65);
    }

    // 60 daily bars: deterministic seed
    const DAYS = 60;
    const barW = Math.max(3, plotW / DAYS);
    const rng = makeRng(88);
    const scanX = LPAD + plotW * clamp(rawT / 0.85, 0, 1);

    for (let d = 0; d < DAYS; d++) {
      const bx = LPAD + d * (plotW / DAYS);
      if (bx > scanX + 8) continue;
      const reveal = clamp((scanX - bx) / 22, 0, 1);

      // Determine if this day has fixed recurring items or random noise
      const isPayday = (d === 8 || d === 22 || d === 36 || d === 50);
      const isRent = (d === 3 || d === 33);
      const isUtility = (d === 12 || d === 42);
      const isGrocery = (d % 7 === 2);
      const isRecurring = isPayday || isRent || isUtility || isGrocery;

      let val = 0;
      if (isPayday) val = 1200;
      else if (isRent) val = -1100;
      else if (isUtility) val = -140;
      else if (isGrocery) val = -85;
      else {
        val = -(10 + rng() * 30);
      }

      const isPositive = val > 0;
      const maxBarH = 26; // Keeps bars strictly within bounds: 98px to 150px
      const bh = Math.min(maxBarH, Math.max(3, (Math.abs(val) / 1200) * maxBarH));
      const by = isPositive ? t1MidY - bh : t1MidY;

      // In Phase 3 (filterT), non-recurring noise dims down to faint background
      let barAlpha = a * reveal;
      if (!isRecurring && filterT > 0) {
        barAlpha *= lerp(0.50, 0.12, filterT);
      } else if (isRecurring && filterT > 0) {
        barAlpha = a * reveal * 0.95;
      } else {
        barAlpha *= (isRecurring ? 0.85 : 0.45);
      }

      const barColor = isPositive ? D.safe : (isRecurring ? D.risk : D.muted);

      ctx.save();
      ctx.globalAlpha = barAlpha;
      ctx.fillStyle = barColor;
      if (isRecurring && filterT > 0.3) {
        ctx.shadowColor = barColor;
        ctx.shadowBlur = 8;
      }
      ctx.fillRect(bx + 0.5, by, barW - 1, Math.max(bh, 1.5));

      // Glow cap on paydays
      if (isPayday && reveal > 0.8) {
        ctx.fillStyle = D.safe;
        ctx.fillRect(bx, by - 1, barW, 2);
      }
      ctx.restore();
    }

    // Sweeping vertical scan beam during rawT
    if (rawT < 0.98) {
      ctx.save();
      ctx.globalAlpha = a * (1 - rawT * 0.3);
      const beamGrad = ctx.createLinearGradient(scanX - 18, 0, scanX + 2, 0);
      beamGrad.addColorStop(0, "rgba(224,203,131,0)");
      beamGrad.addColorStop(1, "rgba(224,203,131,0.65)");
      ctx.fillStyle = beamGrad;
      ctx.fillRect(scanX - 18, t1Top + 14, 18, t1H - 18);
      ctx.strokeStyle = D.blue;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(scanX, t1Top + 14);
      ctx.lineTo(scanX, t1Top + t1H - 4);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ─── Tier 2: Cadence Detection Spectrum ───
  if (cadT > 0) {
    lbl(ctx, "REPEATING CYCLES: DETECTING REGULAR PATTERNS", LPAD, t2Top + 6, 9, D.blue, "left", a * cadT);
    lbl(ctx, "Checking for repeating 14-day and 30-day habits", w - RPAD, t2Top + 6, 8, D.muted, "right", a * cadT * 0.75);

    // Spectrum baseline & confidence threshold
    ctx.save();
    ctx.globalAlpha = a * cadT * 0.22;
    ctx.strokeStyle = D.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(LPAD, t2BaseY);
    ctx.lineTo(w - RPAD, t2BaseY);
    ctx.stroke();

    // Dashed threshold line
    const threshY = t2BaseY - 22;
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = "rgba(224,203,131,0.30)";
    ctx.beginPath();
    ctx.moveTo(LPAD, threshY);
    ctx.lineTo(w - RPAD, threshY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    lbl(ctx, "PERIODICITY THRESHOLD", LPAD + 4, threshY - 4, 7.5, D.blueMid, "left", a * cadT * 0.7);

    // Day tick marks along spectrum axis
    const MAX_LAG = 36;
    const lagToX = (k: number) => LPAD + ((k - 1) / (MAX_LAG - 1)) * plotW;

    const tickMarks: Array<[number, string]> = [
      [7, "7d (Weekly)"],
      [14, "14d (Bi-Weekly)"],
      [21, "21d"],
      [28, "28d"],
      [30, "30d (Monthly)"],
    ];
    for (const [kNum, tag] of tickMarks) {
      const kx = lagToX(kNum);
      lbl(
        ctx,
        tag,
        kx,
        t2BaseY + 12,
        (kNum === 14 || kNum === 30) ? 8.5 : 7.5,
        (kNum === 14 || kNum === 30) ? D.ink : D.muted,
        "center",
        a * cadT * 0.85
      );
    }

    // Continuous spectrum curve (ceiling: t2Top + 44, baseline: t2BaseY)
    const maxCurveH = 46;
    const pts: Array<[number, number]> = [];
    const rngSpec = makeRng(19);

    for (let k = 1; k <= MAX_LAG; k++) {
      const kx = lagToX(k);
      let resonance = 0.04 + rngSpec() * 0.04;
      const dist14 = Math.abs(k - 14);
      if (dist14 <= 2.5) resonance += Math.exp(-0.5 * Math.pow(dist14 / 0.85, 2)) * 0.88;
      const dist30 = Math.abs(k - 30);
      if (dist30 <= 2.5) resonance += Math.exp(-0.5 * Math.pow(dist30 / 0.95, 2)) * 0.84;
      const dist7 = Math.abs(k - 7);
      if (dist7 <= 1.5) resonance += Math.exp(-0.5 * Math.pow(dist7 / 0.75, 2)) * 0.32;

      const reveal = clamp((cadT - (k / MAX_LAG) * 0.7) / 0.3, 0, 1);
      const ky = t2BaseY - resonance * maxCurveH * reveal;
      pts.push([kx, ky]);
    }

    // Fill under curve
    if (pts.length > 1) {
      ctx.save();
      ctx.globalAlpha = a * cadT * 0.12;
      const grad = ctx.createLinearGradient(0, t2Top + 30, 0, t2BaseY);
      grad.addColorStop(0, "rgba(224,203,131,0.5)");
      grad.addColorStop(1, "rgba(224,203,131,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], t2BaseY);
      for (const [px, py] of pts) ctx.lineTo(px, py);
      ctx.lineTo(pts[pts.length - 1][0], t2BaseY);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      glowLine(ctx, pts, D.blue, 2, 8, a * cadT * 0.85);
    }

    // Highlight resonant peaks with badges placed cleanly between header and peak curve
    const badgeY = t2Top + 20; // 14px below header (t2Top + 6), strictly above curve (t2BaseY - 46 = t2Top + 46)
    const peak14T = smooth(0.36, 0.60, t);
    if (peak14T > 0) {
      const x14 = lagToX(14);
      const y14 = t2BaseY - 0.92 * maxCurveH;

      ctx.save();
      ctx.globalAlpha = a * peak14T * 0.45;
      ctx.strokeStyle = D.safe;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x14, t2BaseY);
      ctx.lineTo(x14, y14);
      ctx.stroke();
      ctx.restore();

      dot(ctx, x14, y14, 4, D.safe, 12, a * peak14T);

      // Badge pill
      ctx.save();
      ctx.globalAlpha = a * peak14T;
      const bW = 142, bH = 17;
      ctx.fillStyle = D.card;
      ctx.strokeStyle = D.safeMid;
      ctx.lineWidth = 1;
      ctx.roundRect(x14 - bW / 2, badgeY, bW, bH, 4);
      ctx.fill();
      ctx.stroke();
      lbl(ctx, "★ 14-DAY CADENCE (PAYDAY)", x14, badgeY + 12, 8, D.safe, "center", 1);
      ctx.restore();
    }

    const peak30T = smooth(0.42, 0.66, t);
    if (peak30T > 0) {
      const x30 = lagToX(30);
      const y30 = t2BaseY - 0.88 * maxCurveH;

      ctx.save();
      ctx.globalAlpha = a * peak30T * 0.45;
      ctx.strokeStyle = D.yellow;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x30, t2BaseY);
      ctx.lineTo(x30, y30);
      ctx.stroke();
      ctx.restore();

      dot(ctx, x30, y30, 4, D.yellow, 12, a * peak30T);

      // Badge pill
      ctx.save();
      ctx.globalAlpha = a * peak30T;
      const bW = 148, bH = 17;
      ctx.fillStyle = D.card;
      ctx.strokeStyle = D.blueMid;
      ctx.lineWidth = 1;
      ctx.roundRect(x30 - bW / 2, badgeY, bW, bH, 4);
      ctx.fill();
      ctx.stroke();
      lbl(ctx, "★ 30-DAY CADENCE (BILLS)", x30, badgeY + 12, 8, D.yellow, "center", 1);
      ctx.restore();
    }
  }

  // ─── Tier 3: Regular Cash Streams ───
  if (streamT > 0) {
    lbl(ctx, "REGULAR CASH STREAMS: SCHEDULE LOCKED", LPAD, t3Top + 8, 9, D.safe, "left", a * streamT);
    lbl(ctx, "Combined for 30-day cash forecast", w - RPAD, t3Top + 8, 8, D.muted, "right", a * streamT * 0.75);

    const rawStreams = ex.streams.length ? ex.streams : DEMO_STREAMS;
    const incomeStr = rawStreams.filter(s => s.isIncome).slice(0, 1);
    const billStr   = rawStreams.filter(s => !s.isIncome).slice(0, 3);
    const displayStreams = [...incomeStr, ...billStr];
    if (displayStreams.length === 0) displayStreams.push(...DEMO_STREAMS.slice(0, 4));

    const laneH = 22;
    const laneStartTop = t3Top + 22;

    for (let si = 0; si < displayStreams.length; si++) {
      const s = displayStreams[si];
      const sReveal = clamp((streamT - si * 0.16) / 0.42, 0, 1);
      if (sReveal <= 0) continue;

      const laneY = laneStartTop + si * (laneH + 3);
      const laneMidY = laneY + laneH * 0.5;

      const isInc = s.isIncome;
      const color = isInc ? D.safe : (si === 1 ? D.risk : (si === 2 ? D.yellow : D.purple));
      const cleanName = cleanStreamName(s.name, isInc);

      // Background lane pill with subtle rounded border
      ctx.save();
      ctx.globalAlpha = a * sReveal * 0.28;
      ctx.fillStyle = "rgba(255,253,250,0.03)";
      ctx.strokeStyle = D.axis;
      ctx.lineWidth = 1;
      ctx.roundRect(LPAD, laneY, plotW, laneH, 4);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // Zone 1: Left stream identifier (Icon + Clean Name)
      // Strictly bounded to [LPAD, LPAD + 140], completely clear of all track lines
      dot(ctx, LPAD + 10, laneMidY, 3, color, 6, a * sReveal);
      lbl(ctx, cleanName, LPAD + 20, laneMidY + 3.5, 8.5, D.ink, "left", a * sReveal);

      // Zone 2: Middle Visual Rhythm Timeline
      // Segregated between trackX1 and trackX2 with a protected gap for the cadence pill
      const trackX1 = LPAD + 145;
      const trackX2 = w - RPAD - 150;
      const trackW = trackX2 - trackX1;

      if (trackW > 100) {
        const bracketX = trackX1 + trackW * 0.5;
        const pillW = 86, pillH = 15;
        const gapLeft = bracketX - pillW / 2 - 4;
        const gapRight = bracketX + pillW / 2 + 4;
        const currentEnd = trackX1 + trackW * sReveal;

        // Draw track line in 2 segments so it NEVER intersects or crosses the cadence label
        ctx.save();
        ctx.globalAlpha = a * sReveal * 0.25;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;

        // Left segment (trackX1 to gapLeft)
        if (currentEnd > trackX1) {
          ctx.beginPath();
          ctx.moveTo(trackX1, laneMidY);
          ctx.lineTo(Math.min(currentEnd, gapLeft), laneMidY);
          ctx.stroke();
        }

        // Right segment (gapRight to trackX2)
        if (currentEnd > gapRight) {
          ctx.beginPath();
          ctx.moveTo(gapRight, laneMidY);
          ctx.lineTo(currentEnd, laneMidY);
          ctx.stroke();
        }
        ctx.restore();

        // Repeating cadence dots along track (skipping the middle pill zone)
        const stepDays = s.cadenceDays;
        const totalSimDays = 60;
        for (let d = (s.firstDay || 0); d <= totalSimDays; d += stepDays) {
          const pipX = trackX1 + (d / totalSimDays) * trackW;
          if (pipX > currentEnd) break;
          // Skip drawing pip if it falls within the cadence label pill
          if (pipX >= gapLeft && pipX <= gapRight) continue;
          dot(ctx, pipX, laneMidY, 2.5, color, 8, a * sReveal);
        }

        // Cadence interval badge pill in center with opaque background
        if (sReveal > 0.4) {
          const pillAlpha = a * smooth(0.4, 0.8, sReveal);
          ctx.save();
          ctx.globalAlpha = pillAlpha;
          ctx.fillStyle = D.bg; // Opaque canvas background to prevent any bleed-through
          ctx.strokeStyle = "rgba(255,255,255,0.12)";
          ctx.lineWidth = 1;
          ctx.roundRect(bracketX - pillW / 2, laneMidY - pillH / 2, pillW, pillH, 3);
          ctx.fill();
          ctx.stroke();
          lbl(ctx, `↔ ${s.cadenceDays}d cadence`, bracketX, laneMidY + 3.5, 7.5, D.muted, "center", 1);
          ctx.restore();
        }
      }

      // Zone 3: Right Formatted Amount & Cadence Badge
      // Strictly bounded to [w - RPAD - 145, w - RPAD], completely clear of track lines
      const amtText = `${isInc ? "+" : "−"}${fmtMoney(s.amount)}`;
      const cadText = `/${s.cadenceDays}d`;
      lbl(ctx, amtText, w - RPAD - 54, laneMidY + 3.5, 9, color, "right", a * sReveal);
      lbl(ctx, cadText, w - RPAD - 6, laneMidY + 3.5, 8, D.muted, "right", a * sReveal * 0.85);
    }
  }
}

// ─── SCENE: RISK: Balance Forecast Curve ──────────────────────────────────────
function sceneRisk(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, a: number, ex: Extracted) {
  const safeH = h - HUD_H;
  const LPAD = 72, RPAD = 36, plotW = w - LPAD - RPAD;
  const DAYS = 30;
  const streams = ex.streams.slice(0, 5);
  const nStr = streams.length;

  const usableH = safeH - TOP_OFFSET;
  const impLblY = TOP_OFFSET + 4, impTop = impLblY + 14;
  const impH = Math.min(Math.floor(usableH * 0.30), nStr * 24);
  const rowH = impH / Math.max(nStr, 1);
  const eqY = impTop + impH + 16;
  const balTop = eqY + 20;
  const balH = safeH - balTop - 26; // Guarantees 26px clearance above bottom HUD

  // Stretched timing across 16s
  const streamT      = smooth(0,    0.30, t);
  const eqT          = smooth(0.26, 0.52, t);
  const curveT       = smooth(0.48, 0.80, t);
  const dangerAnnotT = smooth(0.72, 1.00, t);

  // ─── Phase 1: Individual stream impulses ───
  if (streamT > 0) {
    lbl(ctx, "INDIVIDUAL STREAM PROJECTIONS (30 DAYS)", LPAD, impLblY + 8, 9, D.muted, "left", a * streamT);
    lbl(ctx, `B(d) = B₀ + ∑ aᵢ · I(d)`, w - RPAD, impLblY + 8, 9, D.blueMid, "right", a * streamT * 0.75);

    for (let si = 0; si < nStr; si++) {
      const s = streams[si];
      const sReveal = clamp((streamT - si * 0.05) / 0.20, 0, 1);
      if (sReveal <= 0) continue;

      const rowCY = impTop + si * rowH + rowH * 0.5;
      const color = s.isIncome ? D.safe : (si === 1 ? D.risk : (si === 2 ? D.yellow : D.purple));

      lbl(ctx, cleanStreamName(s.name, s.isIncome).slice(0, 12), LPAD - 6, rowCY + 3, 8, color, "right", a * sReveal);

      ctx.save();
      ctx.globalAlpha = a * sReveal * 0.18;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(LPAD, rowCY);
      ctx.lineTo(w - RPAD, rowCY);
      ctx.stroke();
      ctx.restore();

      const stepDays = s.cadenceDays || 30;
      for (let d = (s.firstDay || 1); d <= DAYS; d += stepDays) {
        const hx = LPAD + (d / DAYS) * plotW;
        dot(ctx, hx, rowCY, 2.5, color, 6, a * sReveal);
      }
    }
  }

  // ─── Phase 2: Superposition equation bridge ───
  if (eqT > 0) {
    lbl(ctx, "PROJECTED BALANCE  =  Starting Cash + Scheduled Inflows − Upcoming Bills", LPAD, eqY, 9, D.blueMid, "left", a * eqT * 0.85);
  }

  // ─── Phase 3: Cumulative balance curve ───
  if (curveT > 0 && ex.series.length > 0) {
    const bals = ex.series.slice(0, DAYS).map(d => d.balance);
    const days = Math.min(bals.length, DAYS);
    const minB = Math.min(ex.startBal, ...bals.slice(0, days)) - 80;
    const maxB = Math.max(ex.startBal, ...bals.slice(0, days)) + 80;

    const px2 = (d: number) => LPAD + (d / days) * plotW;
    const py2 = (v: number) => balTop + balH - clamp((v - minB) / (maxB - minB), 0, 1) * balH;

    const wly = clamp(py2(0), balTop, balTop + balH);
    ctx.save();
    ctx.globalAlpha = a * 0.35;
    ctx.strokeStyle = D.risk;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(LPAD, wly);
    ctx.lineTo(w - RPAD, wly);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    lbl(ctx, "WATERLINE  $0", LPAD + 8, wly - 7, 9, D.riskMid, "left", a);

    const b0Y = py2(ex.startBal);
    // Keep the starting-balance label in its own lane rather than drawing it
    // directly on top of the forecast line.
    lbl(ctx, `Starting: ${fmtMoney(ex.startBal)}`, LPAD + 6, Math.max(balTop + 14, b0Y - 10), 9, D.safe, "left", a * smooth(0.48, 0.62, t));

    const pts: Array<[number, number]> = [];
    const visDays = Math.ceil(curveT * days);

    for (let d = 0; d < visDays; d++) {
      pts.push([px2(d + 1), py2(bals[d])]);
    }

    if (pts.length >= 2) {
      glowLine(ctx, pts, D.blue, 2.5, 12, a);

      const [lx, ly] = pts[pts.length - 1];
      dot(ctx, lx, ly, 4, D.blue, 12, a);
    }

    // Days timeline at bottom
    ctx.save();
    ctx.globalAlpha = a * 0.30;
    ctx.font = `500 8px ${CANVAS_FONT}`;
    ctx.fillStyle = D.muted;
    ctx.textAlign = "center";
    for (const d of [1, 7, 14, 21, days]) {
      if (d <= visDays) ctx.fillText(`d${d}`, px2(d), balTop + balH + 12);
    }
    ctx.restore();
  }

  // Danger annotation: offset card with leader line & opaque background so it never overlaps the curve
  if (dangerAnnotT > 0 && ex.series.length > 0) {
    const bals = ex.series.slice(0, DAYS).map(d => d.balance);
    const days = Math.min(bals.length, DAYS);
    const minB = Math.min(ex.startBal, ...bals.slice(0, days)) - 80;
    const maxB = Math.max(ex.startBal, ...bals.slice(0, days)) + 80;
    const px2 = (d: number) => LPAD + (d / days) * plotW;
    const py2 = (v: number) => balTop + balH - clamp((v - minB) / (maxB - minB), 0, 1) * balH;
    const wly = clamp(py2(0), balTop, balTop + balH);
    const dsi = bals.findIndex(b => b < 0);
    if (dsi >= 0) {
      const dx = px2(dsi + 1), db = bals[dsi];
      const dy = py2(db);

      ctx.save();
      const annotationAlpha = a * dangerAnnotT;
      ctx.globalAlpha = annotationAlpha;

      // Vertical deficit indicator to waterline
      ctx.strokeStyle = D.riskMid;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(dx, dy);
      ctx.lineTo(dx, wly);
      ctx.stroke();
      ctx.setLineDash([]);

      // Card dimensions
      const CARD_W = 215, CARD_H = 44;

      // Intelligently place card left or right of the dip point to NEVER intersect the curve
      const placeRight = (dx + CARD_W + 24 < w - RPAD);
      const cardX = placeRight ? (dx + 20) : (dx - CARD_W - 20);

      // Place card vertically above the dip with safe clamping
      const cardY = clamp(dy - CARD_H - 12, balTop + 8, balTop + balH - CARD_H - 8);

      // Angled leader line from dip node to card corner
      const connectX = placeRight ? cardX : (cardX + CARD_W);
      const connectY = cardY + CARD_H * 0.5;
      ctx.strokeStyle = D.riskMid;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(dx, dy);
      ctx.lineTo(connectX, connectY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Reserve a genuinely opaque text lane: the chart may animate behind
      // this card, but it must never reduce legibility inside it.
      ctx.globalAlpha = 1;
      ctx.fillStyle = D.card;
      ctx.strokeStyle = D.riskMid;
      ctx.lineWidth = 1.2;
      ctx.shadowColor = D.riskMid;
      ctx.shadowBlur = 12;
      ctx.roundRect(cardX, cardY, CARD_W, CARD_H, 6);
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Card content
      const dateStr = ex.dangerDay ? ex.dangerDay.date.slice(5) : `Day ${dsi + 1}`;
      lbl(ctx, `PROJECTED DEFICIT (${dateStr})`, cardX + 10, cardY + 16, 9, D.risk, "left", annotationAlpha);
      lbl(ctx, `Balance drops to ${fmtMoney(db)}`, cardX + 10, cardY + 32, 10.5, D.ink, "left", annotationAlpha);

      // Pulsing indicator ring at the dip point
      dot(ctx, dx, dy, 4.5, D.risk, 14, 1);
      ctx.restore();
    }
  }
}

// ─── SCENE: TEST: Cash Flow Stress Test ──────────────────────────────────────
function sceneTest(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, a: number, ex: Extracted) {
  const safeH = h - HUD_H;
  const LPAD = 72, RPAD = 36, plotW = w - LPAD - RPAD;
  const usableH = safeH - TOP_OFFSET;
  const ox = LPAD, oy = safeH - 18;
  const aw = plotW, ah = usableH - 22;

  // Stretched timing across 16s
  const sprayT    = smooth(0,    0.35, t);
  const classifyT = smooth(0.30, 0.60, t);
  const bandT     = smooth(0.52, 0.80, t);
  const medianT   = smooth(0.74, 0.94, t);

  // Axes
  ctx.save(); ctx.globalAlpha = a * 0.22; ctx.strokeStyle = D.axis; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(ox, oy - ah); ctx.lineTo(ox, oy); ctx.lineTo(ox + aw, oy); ctx.stroke(); ctx.restore();

  const N = 90;
  const base: number[] = ex.series.length > 0
    ? ex.series.map(d => d.balance)
    : (() => {
        const arr: number[] = [];
        const ev: Record<number, number> = { 2: -85, 3: -1100, 5: -15.99, 8: 1200, 9: -9.99, 12: -140, 14: -85, 16: 1200, 21: -85 };
        let b = 500;
        for (let d = 1; d <= 30; d++) { b += ev[d] ?? 0; arr.push(b); }
        return arr;
      })();
  const days = base.length;
  const spread = Math.max(300, (Math.max(...base) - Math.min(...base)) * 0.8);
  const minB = Math.min(...base) - spread - 80, maxB = Math.max(...base) + spread + 80;
  const px2 = (d: number) => ox + (d / days) * aw;
  const py2 = (v: number) => oy - clamp((v - minB) / (maxB - minB), 0, 1) * ah;

  // Waterline
  const wly = clamp(py2(0), oy - ah + 8, oy - 8);
  ctx.save(); ctx.globalAlpha = a; ctx.setLineDash([5, 4]); ctx.strokeStyle = D.riskMid; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(ox, wly); ctx.lineTo(ox + aw, wly); ctx.stroke(); ctx.setLineDash([]); ctx.restore();
  lbl(ctx, "WATERLINE  $0", ox + 8, wly - 7, 9, D.riskMid, "left", a);

  // Paths
  const rng = makeRng(7331);
  const paths: Array<{ pts: Array<[number, number]>; safe: boolean }> = [];
  for (let i = 0; i < N; i++) {
    const drift = (rng() - 0.42) * spread * 2.2, vol = (rng() * 0.8 + 0.2) * spread * 0.55;
    const pts: Array<[number, number]> = [];
    let safe = true;
    for (let d = 0; d < days; d++) {
      const v = base[d] + drift * (d / days) + (rng() - 0.5) * vol;
      if (v < 0) safe = false;
      pts.push([px2(d + 1), py2(v)]);
    }
    paths.push({ pts, safe });
  }

  for (let i = 0; i < N; i++) {
    const { pts, safe } = paths[i];
    const reveal = clamp((sprayT - i / N) / 0.38, 0, 1);
    if (reveal <= 0) continue;
    const vp = pts.slice(0, Math.floor(reveal * days));
    const color = classifyT > 0 ? (safe ? D.safeMid : D.riskMid) : D.blueMid;
    ctx.save(); ctx.globalAlpha = a * 0.32;
    if (vp.length > 1) glowLine(ctx, vp, color, 1, 0, 1);
    ctx.restore();
  }

  // Confidence fan (p10 / p90)
  if (bandT > 0) {
    const p10: Array<[number, number]> = [], p90: Array<[number, number]> = [];
    for (let d = 0; d < days; d++) {
      const s = lerp(0, spread, easeOut(d / days)) * bandT;
      p10.push([px2(d + 1), py2(base[d] - s)]);
      p90.push([px2(d + 1), py2(base[d] + s)]);
    }
    ctx.save(); ctx.globalAlpha = a * 0.11 * bandT; ctx.fillStyle = D.blue;
    ctx.beginPath(); ctx.moveTo(p90[0][0], p90[0][1]);
    for (const pt of p90) ctx.lineTo(pt[0], pt[1]);
    for (let i = p10.length - 1; i >= 0; i--) ctx.lineTo(p10[i][0], p10[i][1]);
    ctx.closePath(); ctx.fill(); ctx.restore();
    glowLine(ctx, p10, D.blue, 1.5, 8, a * bandT);
    glowLine(ctx, p90, D.blue, 1.5, 8, a * bandT);

    // Sample badge placed safely at top right
    const shown = Math.floor(ex.sampleCount * bandT);
    ctx.save(); ctx.globalAlpha = a * bandT;
    const CARD_W = 188, CARD_H = 58;
    const bx = w - RPAD - CARD_W, by = TOP_OFFSET + 8;
    // This is an annotation, not a translucent data layer. Its backing must
    // mask the simulation paths that converge beneath it.
    ctx.fillStyle = D.card; ctx.roundRect(bx, by, CARD_W, CARD_H, 6); ctx.fill();
    ctx.strokeStyle = D.blueMid; ctx.lineWidth = 1;
    ctx.roundRect(bx, by, CARD_W, CARD_H, 6); ctx.stroke();
    lbl(ctx, `N = ${shown.toLocaleString()} paths`, bx + 10, by + 19, 11.5, D.blue, "left", 1);
    lbl(ctx, "bootstrapped & scored", bx + 10, by + 34, 8.5, D.muted, "left", 1);
    lbl(ctx, "highlighted line = median", bx + 10, by + 48, 8, D.safe, "left", 1);
    ctx.restore();
  }

  // Median path
  if (medianT > 0) {
    const mp: Array<[number, number]> = base.map((v, d) => [px2(d + 1), py2(v)]);
    glowLine(ctx, mp, D.safe, 2.5, 14, a * Math.min(medianT * 1.6, 1));
  }

  // Classification summary at bottom
  if (classifyT > 0.4) {
    const sn = paths.filter(p => p.safe).length;
    const summaryAlpha = a * smooth(0.4, 0.85, classifyT);
    lbl(ctx, `${sn}/${N} paths clear waterline`, ox + 8, oy - 10, 10, D.safe, "left", summaryAlpha);
    if (ex.peakRisk > 0) {
      lbl(ctx, `Peak overdraft risk: ${fmtPct(ex.peakRisk)}`, ox + 180, oy - 10, 10, D.risk, "left", summaryAlpha);
    }
  }
}

// ─── SCENE: PLAN: Best Action Optimization ───────────────────────────────────
function scenePlan(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, a: number, ex: Extracted) {
  const safeH = h - HUD_H;
  const LPAD = 68, RPAD = 40;
  const aw = w - LPAD - RPAD;

  // Stretched timing across 16s
  const hmT   = smooth(0,    0.30, t);
  const scatT = smooth(0.26, 0.52, t);
  const gradT = smooth(0.42, 0.64, t);
  const pathT = smooth(0.54, 0.88, t);
  const convT = smooth(0.80, 1.00, t);

  function riskSurface(cx: number, cy: number): number {
    const costBenefit = cx * 0.84;
    const timingPenalty = Math.pow(cy - 0.22, 2) * 2.9 + Math.pow(cy - 0.22, 4) * 1.1;
    return Math.max(0, Math.min(1, 0.88 - costBenefit + timingPenalty - cx * (1 - cy) * 0.28));
  }

  // Vertical layout zones:
  // Zone 1: Header & Legend Bar (y: 80 to 102): strictly above the heatmap
  // Zone 2: Heatmap Canvas (y: 106 to 386, ah: 280)
  // Zone 3: Bottom Axis Label Band (y: 394 to 452)
  const TOP = 106;
  const ah = Math.min(280, safeH - TOP - 54);

  // ─── Header & High-Contrast Legend (Above Heatmap) ───
  if (hmT > 0) {
    lbl(ctx, "ACTION COMPARISON: COST VS TIMING", LPAD, TOP - 12, 9, D.safe, "left", a * hmT);

    // Opaque legend pill with balanced symmetrical spacing
    const LEG_W = 158, LEG_H = 18;
    const lgX = w - RPAD - LEG_W, lgY = TOP - 21;
    ctx.save();
    ctx.globalAlpha = a * hmT;
    ctx.fillStyle = D.bg;
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    ctx.roundRect(lgX, lgY, LEG_W, LEG_H, 4);
    ctx.fill();
    ctx.stroke();

    lbl(ctx, "Safe", lgX + 8, lgY + 12, 7.5, D.safe, "left", 1);
    const gradX = lgX + 35, gradW = 58;
    const grad = ctx.createLinearGradient(gradX, 0, gradX + gradW, 0);
    grad.addColorStop(0, D.safe);
    grad.addColorStop(0.5, D.yellow);
    grad.addColorStop(1, D.risk);
    ctx.fillStyle = grad;
    ctx.fillRect(gradX, lgY + 6, gradW, 6);

    lbl(ctx, "High Risk", gradX + gradW + 6, lgY + 12, 7.5, D.risk, "left", 1);
    ctx.restore();
  }

  // ─── Axis Labels (Cleanly in Margins) ───
  if (hmT > 0.2) {
    lbl(ctx, "REBALANCING COST (TRANSFER AMOUNT)  →", LPAD + aw / 2, TOP + ah + 22, 8.5, D.muted, "center", a * hmT);
    ctx.save();
    ctx.translate(LPAD - 28, TOP + ah / 2);
    ctx.rotate(-Math.PI / 2);
    lbl(ctx, "TIMING ADJUSTMENT (DAYS)  →", 0, 0, 8.5, D.muted, "center", a * hmT);
    ctx.restore();
  }

  // ─── 2D Risk Heatmap ───
  if (hmT > 0) {
    const COLS = 34, ROWS = 20;
    const cw = aw / COLS, rh = ah / ROWS;
    for (let ci = 0; ci < COLS; ci++) {
      for (let ri = 0; ri < ROWS; ri++) {
        const cx = (ci + 0.5) / COLS, cy = (ri + 0.5) / ROWS;
        const risk = riskSurface(cx, cy);
        const revealDist = (ci / COLS) * 0.6 + (ri / ROWS) * 0.4;
        const reveal = clamp((hmT - revealDist * 0.6) / 0.55, 0, 1);
        if (reveal <= 0) continue;
        let r: number, g: number, b: number;
        if (risk < 0.5) {
          r = Math.round(lerp(63, 227, risk * 2));
          g = Math.round(lerp(185, 179, risk * 2));
          b = Math.round(lerp(80, 16, risk * 2));
        } else {
          r = Math.round(lerp(227, 248, (risk - 0.5) * 2));
          g = Math.round(lerp(179, 81, (risk - 0.5) * 2));
          b = Math.round(lerp(16, 73, (risk - 0.5) * 2));
        }
        ctx.save();
        ctx.globalAlpha = a * reveal * 0.72;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(LPAD + ci * cw, TOP + ri * rh, cw + 0.5, rh + 0.5);
        ctx.restore();
      }
    }
  }

  // ─── Candidate Scatter Dots ───
  if (scatT > 0) {
    const N = Math.max(12, Math.min(ex.candidateCount, 26));
    const rng = makeRng(1234);
    for (let i = 0; i < N; i++) {
      const cx = rng() * 0.88 + 0.04, cy = rng() * 0.82 + 0.06;
      const reveal = clamp((scatT - i / N) / 0.35, 0, 1);
      if (reveal <= 0) continue;
      dot(ctx, LPAD + cx * aw, TOP + cy * ah, 4, D.blue, 6, a * reveal * 0.85);
    }

    // Candidate count badge in bottom-right margin (completely separate from risk card)
    if (scatT > 0.4) {
      const bAlpha = a * smooth(0.4, 0.8, scatT);
      const bW = 156, bH = 20;
      const bx = w - RPAD - bW - 4, by = TOP + ah - bH - 8;
      ctx.save();
      ctx.globalAlpha = bAlpha;
      ctx.fillStyle = D.bg;
      ctx.strokeStyle = "rgba(224,203,131,0.35)";
      ctx.lineWidth = 1;
      ctx.roundRect(bx, by, bW, bH, 4);
      ctx.fill();
      ctx.stroke();
      lbl(ctx, `✓ ${N} candidates evaluated`, bx + bW / 2, by + 13.5, 8, D.blue, "center", 1);
      ctx.restore();
    }
  }

  // ─── Gradient Field Vectors ───
  if (gradT > 0) {
    const GCOLS = 9, GROWS = 6;
    for (let ci = 0; ci < GCOLS; ci++) {
      for (let ri = 0; ri < GROWS; ri++) {
        const cx = (ci + 0.5) / GCOLS, cy = (ri + 0.5) / GROWS;
        const dRdcx = (riskSurface(cx + 0.04, cy) - riskSurface(cx - 0.04, cy)) / 0.08;
        const dRdcy = (riskSurface(cx, cy + 0.04) - riskSurface(cx, cy - 0.04)) / 0.08;
        const mag = Math.sqrt(dRdcx * dRdcx + dRdcy * dRdcy);
        if (mag < 0.02) continue;
        const nx = -dRdcx / mag, ny = -dRdcy / mag;
        const ax = LPAD + cx * aw, ay = TOP + cy * ah;
        const AL = Math.min(aw / GCOLS, ah / GROWS) * 0.36;
        const ex2 = ax + nx * AL, ey2 = ay + ny * AL;
        ctx.save();
        ctx.globalAlpha = a * gradT * 0.48;
        ctx.strokeStyle = D.yellow;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ex2, ey2);
        ctx.stroke();
        const ang = Math.atan2(ey2 - ay, ex2 - ax);
        ctx.fillStyle = D.yellow;
        ctx.beginPath();
        ctx.moveTo(ex2, ey2);
        ctx.lineTo(ex2 - 5 * Math.cos(ang - 0.45), ey2 - 5 * Math.sin(ang - 0.45));
        ctx.lineTo(ex2 - 5 * Math.cos(ang + 0.45), ey2 - 5 * Math.sin(ang + 0.45));
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
  }

  // ─── Gradient Descent Path & Opaque Risk Readout ───
  if (pathT > 0) {
    const LR = 0.055, STEPS = 44;
    const path: Array<{ cx: number; cy: number; risk: number }> =
      [{ cx: 0.06, cy: 0.80, risk: riskSurface(0.06, 0.80) }];
    for (let i = 0; i < STEPS; i++) {
      const { cx, cy } = path[path.length - 1];
      const dRdcx = (riskSurface(cx + 0.02, cy) - riskSurface(cx - 0.02, cy)) / 0.04;
      const dRdcy = (riskSurface(cx, cy + 0.02) - riskSurface(cx, cy - 0.02)) / 0.04;
      path.push({ cx: clamp(cx - LR * dRdcx, 0.02, 0.97), cy: clamp(cy - LR * dRdcy, 0.02, 0.97), risk: 0 });
      path[path.length - 1].risk = riskSurface(path[path.length - 1].cx, path[path.length - 1].cy);
    }
    const visSt = Math.floor(pathT * (STEPS + 1));
    const visPath = path.slice(0, visSt);
    if (visPath.length > 1) {
      glowLine(ctx, visPath.map(p => [LPAD + p.cx * aw, TOP + p.cy * ah]), D.safe, 2.5, 14, a);
    }
    if (visSt > 0) {
      const cp = path[Math.min(visSt - 1, STEPS)];
      const ppx = LPAD + cp.cx * aw, ppy = TOP + cp.cy * ah;
      for (let ring = 0; ring < 3; ring++) {
        ctx.save();
        ctx.globalAlpha = a * (1 - ring * 0.3) * 0.65;
        ctx.strokeStyle = D.safe;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(ppx, ppy, 6 + ring * 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      dot(ctx, ppx, ppy, 6, D.safe, 20, a);

      // Dedicated opaque risk readout card in bottom-left (never overlapping candidates or gradient text)
      const CARD_W = 164, CARD_H = 44;
      const bx = LPAD + 8, by = TOP + ah - CARD_H - 8;
      ctx.save();
      ctx.globalAlpha = a * pathT;
      ctx.fillStyle = D.bg; // 100% opaque to block out heatmap
      ctx.strokeStyle = D.safeMid;
      ctx.lineWidth = 1.2;
      ctx.shadowColor = "rgba(0,0,0,0.28)";
      ctx.shadowBlur = 10;
      ctx.roundRect(bx, by, CARD_W, CARD_H, 6);
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;

      lbl(ctx, "CURRENT RISK ESTIMATE", bx + 10, by + 15, 7.5, D.muted, "left", 1);
      const dispRisk = lerp(ex.beforeRisk || 0.73, cp.risk, easeOut(pathT));
      ctx.font = `700 18px ${CANVAS_FONT}`;
      ctx.fillStyle = D.safe;
      ctx.fillText(fmtPct(dispRisk), bx + 10, by + 35);
      ctx.restore();
    }
  }

  // ─── Optimal Solution Convergence Callout ───
  if (convT > 0) {
    const optCx = 0.44, optCy = 0.21;
    const opx = LPAD + optCx * aw, opy = TOP + optCy * ah;

    ctx.save();
    ctx.globalAlpha = a * convT;

    const CARD_W = 210, CARD_H = 46;
    // Offset card to the right of the optimal point with clear leader line
    const placeRight = (opx + CARD_W + 24 < w - RPAD);
    const cardX = placeRight ? (opx + 18) : (opx - CARD_W - 18);
    const cardY = clamp(opy - CARD_H / 2, TOP + 6, TOP + ah - CARD_H - 6);

    // Leader line from target point to card
    const connectX = placeRight ? cardX : (cardX + CARD_W);
    const connectY = cardY + CARD_H / 2;
    ctx.strokeStyle = D.safeMid;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(opx, opy);
    ctx.lineTo(connectX, connectY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Solid opaque card with clean emerald glow
    ctx.fillStyle = D.card;
    ctx.strokeStyle = D.safe;
    ctx.lineWidth = 1.4;
    ctx.shadowColor = D.safeMid;
    ctx.shadowBlur = 14;
    ctx.roundRect(cardX, cardY, CARD_W, CARD_H, 6);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    const optTitle = ex.recommended ? `✓  OPTIMAL PLAN: ${fmtMoney(ex.recommended.amount)}` : "✓  OPTIMAL STRATEGY SELECTED";
    const optSub = ex.recommended
      ? `Risk reduced from ${fmtPct(ex.beforeRisk)} → ${fmtPct(ex.recommended.risk)}`
      : `${ex.candidateCount} options evaluated`;

    lbl(ctx, optTitle, cardX + 10, cardY + 17, 9, D.safe, "left", 1);
    lbl(ctx, optSub, cardX + 10, cardY + 33, 8, D.ink, "left", 1);

    // Glowing target marker at the optimal convergence coordinate
    dot(ctx, opx, opy, 5, D.safe, 16, 1);
    ctx.restore();
  }
}

// ─── SCENE: SPEND: Safe Allowance Search (Spacious Full Canvas) ───────────────
function sceneSpend(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, a: number, ex: Extracted) {
  const safeWeekly = ex.safeWeekly;
  const safeDaily = safeWeekly / 7;

  // 4 choreographed phases across 16s:
  // Phase 1 (0.00 - 0.28): Initial candidate $50/day line glides in and breaches -$240
  // Phase 2 (0.28 - 0.54): The breach highlighted; $50/day dims into a reference ghost
  // Phase 3 (0.54 - 0.78): 3 candidate trajectories ($44/d, $38/d, $34/d) glide across sequentially
  // Phase 4 (0.78 - 1.00): Winning emerald trajectory ($31.67/d = $221.71/wk) sweeps in & locks

  const isStep1 = t < 0.28;
  const isStep2 = t >= 0.28 && t < 0.54;
  const isStep3 = t >= 0.54 && t < 0.78;
  const isStep4 = t >= 0.78;

  ctx.save();
  ctx.globalAlpha = a;

  // ───────────────────────────────────────────────────────────────────────────
  // GEOMETRY & VIEWPORT
  // ───────────────────────────────────────────────────────────────────────────
  const LPAD = 72;
  const RPAD = 48;
  const plotW = w - LPAD - RPAD;
  const gx0 = LPAD;
  const gx1 = w - RPAD;

  // Vertical layout:
  // Header: y: 68 to 86
  // Divider: y = 92
  // Graph: gy0 = 104, gy1 = 352 (height = 248px)
  // Waterline ($0): zeroY = 296px
  // Timeline labels: gy1 + 14 = 366px
  // Hero Result Bar: botY = 388, botH = 46 (ends at 434px, 26px clearance above HUD)
  const gy0 = 104;
  const gy1 = 352;
  const zeroY = 296;

  // Y-Scale parameters: Headroom up to $2,200 (prevents any ceiling clipping)
  const maxPos = 2200;
  const maxNeg = 400;

  // ───────────────────────────────────────────────────────────────────────────
  // TRAJECTORY DATA GENERATOR
  // ───────────────────────────────────────────────────────────────────────────
  const daysCount = 30;
  function getPathPoints(burnRate: number, buffer: number) {
    const pts: { x: number; y: number; bal: number }[] = [];
    let bal = 1360;
    for (let d = 0; d < daysCount; d++) {
      if (d === 3) bal -= 1400 - buffer; // Day 3: Rent ($1,100) + fixed bills
      if (d === 14) bal += 1200;         // Day 14: Paycheck 1
      if (d === 28) bal += 1200;         // Day 28: Paycheck 2
      bal -= burnRate;                   // Daily spending burn rate

      const px = gx0 + (d / (daysCount - 1)) * plotW;
      const py = bal >= 0
        ? zeroY - (bal / maxPos) * (zeroY - gy0)
        : zeroY + (Math.abs(bal) / maxNeg) * (gy1 - zeroY);

      pts.push({ x: px, y: clamp(py, gy0 + 2, gy1 - 2), bal });
    }
    return pts;
  }

  // Pre-calculate trajectory points
  const pts50   = getPathPoints(50, 0);
  const pts44   = getPathPoints(44, 60);
  const pts38   = getPathPoints(38, 120);
  const pts34   = getPathPoints(34, 160);
  const ptsSafe = getPathPoints(safeDaily, 200);

  // Smooth parametric spline interpolation (clean linear head, zero bezier loops)
  function drawSmoothTrajectory(pts: { x: number; y: number }[], progress = 1) {
    if (progress <= 0 || pts.length < 2) return null;
    const clampedP = clamp(progress, 0, 1);
    const totalSegs = pts.length - 1;
    const curParam = clampedP * totalSegs;
    const endSeg = Math.min(totalSegs - 1, Math.floor(curParam));
    const frac = curParam - endSeg;

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);

    for (let i = 0; i < endSeg; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      const midX = (p0.x + p1.x) / 2;
      ctx.bezierCurveTo(midX, p0.y, midX, p1.y, p1.x, p1.y);
    }

    let headX = pts[endSeg].x;
    let headY = pts[endSeg].y;
    if (endSeg < totalSegs && frac > 0.001) {
      const p0 = pts[endSeg];
      const p1 = pts[endSeg + 1];
      headX = lerp(p0.x, p1.x, frac);
      const t1 = frac;
      const t0 = 1 - t1;
      headY = t0 * t0 * t0 * p0.y + 3 * t0 * t0 * t1 * p0.y + 3 * t0 * t1 * t1 * p1.y + t1 * t1 * t1 * p1.y;
      ctx.lineTo(headX, headY);
    }

    ctx.stroke();
    return { headX, headY };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // LAYER 1: BACKGROUND WASHES (Drawn FIRST so they never hide lines or grid)
  // ───────────────────────────────────────────────────────────────────────────
  // Danger Zone Red Shading below $0 line
  const dangerGrad = ctx.createLinearGradient(0, zeroY, 0, gy1);
  dangerGrad.addColorStop(0, "rgba(240, 163, 141, 0.12)");
  dangerGrad.addColorStop(1, "rgba(240, 163, 141, 0.015)");
  ctx.fillStyle = dangerGrad;
  ctx.fillRect(gx0, zeroY, plotW, gy1 - zeroY);

  // Safe Green Cushion Area Fill under Winning Curve (Drawn behind grid/lines)
  const p4 = smooth(0.76, 0.94, t);
  if (t >= 0.76 && p4 > 0.05) {
    ctx.save();
    ctx.globalAlpha = a * smooth(0.76, 0.94, t) * 0.22;
    ctx.beginPath();
    ctx.moveTo(ptsSafe[0].x, zeroY);
    ctx.lineTo(ptsSafe[0].x, ptsSafe[0].y);
    for (let i = 0; i < ptsSafe.length - 1; i++) {
      const p0 = ptsSafe[i];
      const p1 = ptsSafe[i + 1];
      const midX = (p0.x + p1.x) / 2;
      ctx.bezierCurveTo(midX, p0.y, midX, p1.y, p1.x, p1.y);
    }
    ctx.lineTo(ptsSafe[ptsSafe.length - 1].x, zeroY);
    ctx.closePath();

    const greenGrad = ctx.createLinearGradient(0, gy0, 0, zeroY);
    greenGrad.addColorStop(0, "rgba(168, 215, 174, 0.40)");
    greenGrad.addColorStop(1, "rgba(168, 215, 174, 0.02)");
    ctx.fillStyle = greenGrad;
    ctx.fill();
    ctx.restore();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // LAYER 2: GRID GUIDELINES & AXES
  // ───────────────────────────────────────────────────────────────────────────
  const y1500 = zeroY - (1500 / maxPos) * (zeroY - gy0);
  const y750  = zeroY - (750 / maxPos)  * (zeroY - gy0);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(gx0, y1500); ctx.lineTo(gx1, y1500);
  ctx.moveTo(gx0, y750);  ctx.lineTo(gx1, y750);
  ctx.stroke();

  // Y-axis tick labels in the left gutter (LPAD - 8)
  lbl(ctx, "+$1,500", gx0 - 8, y1500 + 3.5, 7.5, D.muted, "right", 0.55);
  lbl(ctx, "+$750",   gx0 - 8, y750 + 3.5,  7.5, D.muted, "right", 0.55);

  // $0 Waterline Dashed Line across the entire graph width
  ctx.strokeStyle = D.riskMid;
  ctx.lineWidth = 1.2;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(gx0, zeroY);
  ctx.lineTo(gx1, zeroY);
  ctx.stroke();
  ctx.setLineDash([]);

  // $0 Waterline Label placed cleanly in the LEFT GUTTER (outside graph plot!)
  lbl(ctx, "$0 WATERLINE", gx0 - 8, zeroY + 3.5, 7.5, D.risk, "right", 0.9);

  // Negative level label in left gutter
  lbl(ctx, "-$250", gx0 - 8, gy1 - 6, 7.5, D.risk, "right", 0.65);

  // Vertical milestone dashed guidelines
  const d3x  = gx0 + (3 / 29) * plotW;
  const d14x = gx0 + (14 / 29) * plotW;
  const d28x = gx0 + (28 / 29) * plotW;

  ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(d3x, gy0);  ctx.lineTo(d3x, gy1);
  ctx.moveTo(d14x, gy0); ctx.lineTo(d14x, gy1);
  ctx.moveTo(d28x, gy0); ctx.lineTo(d28x, gy1);
  ctx.stroke();
  ctx.setLineDash([]);

  // X-Axis Timeline Milestones. The final two dates are too close together
  // for full labels, so retain the meaningful payday marker and let the plot
  // boundary communicate Day 30 rather than colliding text at the edge.
  lbl(ctx, "Day 1", gx0, gy1 + 14, 7.5, D.muted, "left", 0.6);
  lbl(ctx, "Day 3 (Rent)", d3x, gy1 + 14, 7.5, D.muted, "center", 0.75);
  lbl(ctx, "Day 14 (Paycheck)", d14x, gy1 + 14, 7.5, D.muted, "center", 0.75);
  lbl(ctx, "Day 28", d28x, gy1 + 14, 7.5, D.muted, "center", 0.65);

  // ───────────────────────────────────────────────────────────────────────────
  // LAYER 3: TRAJECTORY CURVES
  // ───────────────────────────────────────────────────────────────────────────
  // 1. Initial $50/day Trajectory
  const p1 = smooth(0.00, 0.28, t);
  if (t < 0.54) {
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = D.risk;
    const head = drawSmoothTrajectory(pts50, isStep1 ? p1 : 1);
    if (isStep1 && head && p1 < 0.99) {
      dot(ctx, head.headX, head.headY, 4, D.risk, 10, 1);
    }
  } else {
    // Dimmed Reference Ghost Line
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = D.riskDim;
    drawSmoothTrajectory(pts50, 1);
    lbl(ctx, "$50/d", gx1 - 4, pts50[29].y - 4, 7, D.risk, "right", 0.6);
  }

  // 2. Candidate Trajectories (Phase 3)
  if (t >= 0.54) {
    // Candidate A: $44/day (0.54 - 0.64)
    const progA = smooth(0.54, 0.64, t);
    const alpha44 = clamp(progA * 2, 0, isStep4 ? 0.18 : 0.45);
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = `rgba(240, 163, 141, ${alpha44})`;
    const headA = drawSmoothTrajectory(pts44, progA);
    if (!isStep4 && headA && progA > 0.05 && progA < 0.99) {
      dot(ctx, headA.headX, headA.headY, 3, D.risk, 8, 1);
    }

    // Candidate B: $38/day (0.61 - 0.71)
    const progB = smooth(0.61, 0.71, t);
    if (progB > 0) {
      const alpha38 = clamp(progB * 2, 0, isStep4 ? 0.22 : 0.6);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = `rgba(224, 203, 131, ${alpha38})`;
      const headB = drawSmoothTrajectory(pts38, progB);
      if (!isStep4 && headB && progB > 0.05 && progB < 0.99) {
        dot(ctx, headB.headX, headB.headY, 3, D.blue, 8, 1);
      }
    }

    // Candidate C: $34/day (0.68 - 0.78)
    const progC = smooth(0.68, 0.78, t);
    if (progC > 0) {
      const alpha34 = clamp(progC * 2, 0, isStep4 ? 0.28 : 0.75);
      ctx.lineWidth = 1.7;
      ctx.strokeStyle = `rgba(231, 189, 118, ${alpha34})`;
      const headC = drawSmoothTrajectory(pts34, progC);
      if (!isStep4 && headC && progC > 0.05 && progC < 0.99) {
        dot(ctx, headC.headX, headC.headY, 3.5, D.yellow, 10, 1);
      }
    }

    // Candidate endpoint badges (shown only during Phase 3, cleanly hidden in Phase 4)
    if (isStep3) {
      if (progA > 0.9) {
        lbl(ctx, "$44/d", gx1 - 4, pts44[29].y - 4, 7, D.risk, "right", 1);
      }
      if (progB > 0.9) {
        lbl(ctx, "$38/d", gx1 - 4, pts38[29].y - 4, 7, D.blue, "right", 1);
      }
      if (progC > 0.9) {
        lbl(ctx, "$34/d", gx1 - 4, pts34[29].y - 4, 7, D.yellow, "right", 1);
      }
    }
  }

  // 3. Winning Optimal Trajectory ($31.67/day = $221.71/week)
  if (t >= 0.76) {
    ctx.lineWidth = 2.8;
    ctx.strokeStyle = D.safe;
    ctx.shadowColor = D.safeMid;
    ctx.shadowBlur = 12;
    const safeHead = drawSmoothTrajectory(ptsSafe, p4);
    ctx.shadowBlur = 0;

    if (safeHead && p4 < 0.99) {
      dot(ctx, safeHead.headX, safeHead.headY, 5, D.safe, 14, 1);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // LAYER 4: ANNOTATIONS, PINGS & CALLOUT BADGES
  // ───────────────────────────────────────────────────────────────────────────
  // Keep the original Day 3 low point visible through the candidate-comparison
  // phase; the safe-cushion annotation replaces it only in the final phase.
  if (t < 0.78 && p1 > 0.15) {
    const d3 = pts50[3];
    dot(ctx, d3.x, d3.y, 4.5, D.risk, 14, 1);

    const lowLabelW = 118;
    const lowLabelH = 18;
    const lowLabelX = Math.min(d3.x + 12, gx1 - lowLabelW);
    const lowLabelY = Math.max(gy0 + 8, d3.y - lowLabelH - 12);
    ctx.fillStyle = D.card;
    ctx.roundRect(lowLabelX, lowLabelY, lowLabelW, lowLabelH, 3);
    ctx.fill();
    ctx.strokeStyle = D.riskMid;
    ctx.lineWidth = 0.9;
    ctx.roundRect(lowLabelX, lowLabelY, lowLabelW, lowLabelH, 3);
    ctx.stroke();

    // Day 30 Failed Endpoint Pill
    if (p1 > 0.95 || isStep2) {
      ctx.fillStyle = D.card;
      ctx.roundRect(gx1 - 96, pts50[29].y - 9, 94, 18, 4);
      ctx.fill();
      ctx.strokeStyle = D.riskMid;
      ctx.lineWidth = 0.9;
      ctx.roundRect(gx1 - 96, pts50[29].y - 9, 94, 18, 4);
      ctx.stroke();
      lbl(ctx, "$50/day (Failed)", gx1 - 49, pts50[29].y + 3.5, 7.5, D.risk, "center", 1);
    }
  }

  // Phase 4: Day 3 Cushion, Day 14 Paycheck, and Winning Endpoint
  if (t >= 0.76) {
    // Day 3 Safe Cushion Dot & Radar Ping
    const d3Safe = ptsSafe[3];
    dot(ctx, d3Safe.x, d3Safe.y, 5, D.safe, 14, 1);

    const pingR = 5 + Math.sin(t * 8) * 3;
    ctx.strokeStyle = D.safeMid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(d3Safe.x, d3Safe.y, pingR, 0, Math.PI * 2);
    ctx.stroke();

    // Cushion callout stays with its marker in the same animation phase.
    const cushionW = 148;
    const cushionH = 19;
    const cushionX = d3Safe.x + 8;
    const cushionY = d3Safe.y - 24;
    ctx.fillStyle = D.card;
    ctx.roundRect(cushionX, cushionY, cushionW, cushionH, 4);
    ctx.fill();
    ctx.strokeStyle = D.safeMid;
    ctx.lineWidth = 0.9;
    ctx.roundRect(cushionX, cushionY, cushionW, cushionH, 4);
    ctx.stroke();
    lbl(ctx, "SAFE CUSHION · +$33", cushionX + cushionW / 2, cushionY + 12.5, 7.5, D.safe, "center", 0.95);

    // Day 14 Paycheck Spike Badge. It arrives with the drawn line rather than
    // popping in at the start of the final phase.
    if (p4 >= 14 / (daysCount - 1)) {
      const d14Safe = ptsSafe[14];
      dot(ctx, d14Safe.x, d14Safe.y, 4, D.blue, 8, 1);
      ctx.fillStyle = D.card;
      ctx.roundRect(d14Safe.x - 48, d14Safe.y - 20, 96, 17, 3);
      ctx.fill();
      ctx.strokeStyle = "rgba(155,201,182,0.5)";
      ctx.lineWidth = 0.8;
      ctx.roundRect(d14Safe.x - 48, d14Safe.y - 20, 96, 17, 3);
      ctx.stroke();
    }

    // Winning Endpoint Badge (exclusively featured on the right edge)
    if (p4 > 0.9) {
      const endPillW = 104;
      ctx.fillStyle = D.card;
      ctx.roundRect(gx1 - endPillW, ptsSafe[29].y - 10, endPillW, 20, 4);
      ctx.fill();
      ctx.strokeStyle = D.safeMid;
      ctx.lineWidth = 1.1;
      ctx.roundRect(gx1 - endPillW, ptsSafe[29].y - 10, endPillW, 20, 4);
      ctx.stroke();
      lbl(ctx, `✓ ${fmtMoney(safeDaily)}/d (Safe)`, gx1 - endPillW / 2, ptsSafe[29].y + 3.5, 7.5, D.safe, "center", 1);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // LAYER 5: TOP HEADER (Rendered with strict collision guard)
  // ───────────────────────────────────────────────────────────────────────────
  lbl(ctx, "OVERCAST ENGINE", gx0, 78, 8.5, D.blue, "left", 0.95);
  lbl(ctx, "·  SOLVENCY HORIZON SEARCH", gx0 + 94, 78, 8, D.muted, "left", 0.85);

  const statusTag = isStep4
    ? "CEILING LOCKED"
    : isStep3
      ? "MULTI-PATH SEARCH"
      : isStep2
        ? "DAY 3 BREACH (-$240)"
        : "TESTING $50/DAY";
  const statusColor = isStep4 ? D.safe : isStep3 ? D.yellow : D.risk;
  const statusBg = isStep4
    ? D.safeDim
    : isStep3
      ? D.blueDim
      : D.riskDim;
  const statusBorder = isStep4
    ? D.safeMid
    : isStep3
      ? D.blueMid
      : D.riskMid;

  ctx.font = `700 8px ${CANVAS_FONT}`;
  const tagW = ctx.measureText(statusTag).width + 16;
  const tagX = gx1 - tagW;
  // Render badge only if it doesn't collide with header title
  if (tagX > gx0 + 240) {
    ctx.fillStyle = statusBg;
    ctx.roundRect(tagX, 68, tagW, 19, 4);
    ctx.fill();
    ctx.strokeStyle = statusBorder;
    ctx.lineWidth = 1;
    ctx.roundRect(tagX, 68, tagW, 19, 4);
    ctx.stroke();
    lbl(ctx, statusTag, tagX + tagW / 2, 80.5, 8, statusColor, "center", 1);
  }

  // Header Divider Line
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(gx0, 92);
  ctx.lineTo(gx1, 92);
  ctx.stroke();

  // ───────────────────────────────────────────────────────────────────────────
  // LAYER 6: BOTTOM HERO RESULT BAR (Spacious, perfectly offset, h = 46px)
  // ───────────────────────────────────────────────────────────────────────────
  const botX = gx0;
  const botW = plotW;
  const botY = 396;
  const botH = 46;

  if (isStep4) {
    // Ultra-Clean Apple/Linear Style Emerald Hero Box
    ctx.fillStyle = D.card;
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.roundRect(botX, botY, botW, botH, 4);
    ctx.fill();
    ctx.shadowColor = "transparent";

    ctx.strokeStyle = D.safeMid;
    ctx.lineWidth = 1.2;
    ctx.roundRect(botX, botY, botW, botH, 4);
    ctx.stroke();

    // Left Circular Checkmark Badge
    const iconR = 9;
    const iconCx = botX + 20;
    const iconCy = botY + 23;
    ctx.fillStyle = D.safe;
    ctx.beginPath();
    ctx.arc(iconCx, iconCy, iconR, 0, Math.PI * 2);
    ctx.fill();
    lbl(ctx, "✓", iconCx, iconCy + 3.5, 8.5, D.ink, "center", 1);

    // Dynamic horizontal accumulation for zero text overlap
    let curX = iconCx + 16;
    lbl(ctx, "SAFE ALLOWANCE:", curX, botY + 16, 7.5, D.safe, "left", 1);
    ctx.font = `700 7.5px ${CANVAS_FONT}`;
    curX += ctx.measureText("SAFE ALLOWANCE:").width + 8;

    const weeklyStr = fmtMoney(safeWeekly);
    ctx.font = `700 16px ${CANVAS_FONT}`;
    ctx.fillStyle = D.ink;
    ctx.textAlign = "left";
    ctx.fillText(weeklyStr, curX, botY + 20);
    curX += ctx.measureText(weeklyStr).width + 5;

    ctx.font = `600 11px ${CANVAS_FONT}`;
    ctx.fillStyle = D.safe;
    ctx.fillText("/ week", curX, botY + 19);
    curX += ctx.measureText("/ week").width + 8;

    const dailyStr = `(${fmtMoney(safeDaily)} / day)`;
    ctx.font = `500 10px ${CANVAS_FONT}`;
    ctx.fillStyle = D.muted;
    ctx.fillText(dailyStr, curX, botY + 19);
    curX += ctx.measureText(dailyStr).width;

    // Row 2: Subtitle
    lbl(ctx, "Rent ($1,100), bills, and safety buffer 100% solvent across all 30 days.", iconCx + 16, botY + 34, 8, D.muted, "left", 0.9);

    // Right Status Badge Pill (only drawn if width permits, no collision)
    const rightBadgeW = 142;
    const rightBadgeX = botX + botW - rightBadgeW - 12;
    if (rightBadgeX > curX + 30) {
      ctx.fillStyle = D.safeDim;
      ctx.roundRect(rightBadgeX, botY + 13, rightBadgeW, 20, 4);
      ctx.fill();
      ctx.strokeStyle = D.safeMid;
      ctx.lineWidth = 1;
      ctx.roundRect(rightBadgeX, botY + 13, rightBadgeW, 20, 4);
      ctx.stroke();
      lbl(ctx, "100% SOLVENT · 0% RISK", rightBadgeX + rightBadgeW / 2, botY + 26, 7.5, D.safe, "center", 1);
    }
  } else {
    // Neutral Solver Status Box
    ctx.fillStyle = "rgba(255,253,250,0.035)";
    ctx.roundRect(botX, botY, botW, botH, 4);
    ctx.fill();

    ctx.strokeStyle = D.axis;
    ctx.lineWidth = 1;
    ctx.roundRect(botX, botY, botW, botH, 4);
    ctx.stroke();

    const statusMsg = isStep1
      ? "Simulating candidate $50.00/day spending speed against 30-day timeline…"
      : isStep2
        ? "Overdraft breach detected on Day 3 (-$240). Reducing spending velocity…"
        : "Searching candidate trajectories ($44/d → $38/d → $34/d) to clear waterline…";
    const statusColor = isStep2 ? D.risk : isStep3 ? D.yellow : D.muted;

    lbl(ctx, "SOLVENCY SIMULATION IN PROGRESS", botX + 16, botY + 18, 8, D.blue, "left", 1);
    lbl(ctx, "OBJECTIVE: Min Balance ≥ $0", botX + botW - 16, botY + 18, 7.5, D.muted, "right", 1);
    lbl(ctx, statusMsg, botX + 16, botY + 34, 8.5, statusColor, "left", 1);
  }

  ctx.restore();
}

// ─── Master paint ─────────────────────────────────────────────────────────────
function paintFrame(
  ctx: CanvasRenderingContext2D, scene: AnimationScene,
  w: number, h: number, t: number, outroT: number, fadeInT: number,
  ex: Extracted, card: ResultCard,
) {
  let bg: string;
  if (fadeInT<1) bg=lerpHex(L.bg,D.bg,easeOut(fadeInT));
  else if (outroT>0) bg=lerpHex(D.bg,L.bg,easeOut(outroT));
  else bg=D.bg;
  ctx.fillStyle=bg; ctx.fillRect(0,0,w,h);
  const sceneA=outroT>0?clamp(1-outroT*3.2,0,1):Math.min(fadeInT,1);
  if(sceneA>0.01){
    drawGrid(ctx,w,h,sceneA);
    switch(scene){
      case "position": scenePosition(ctx,w,h,t,sceneA,ex); break;
      case "risk":     sceneRisk    (ctx,w,h,t,sceneA,ex); break;
      case "test":     sceneTest    (ctx,w,h,t,sceneA,ex); break;
      case "plan":     scenePlan    (ctx,w,h,t,sceneA,ex); break;
      case "spend":    sceneSpend   (ctx,w,h,t,sceneA,ex); break;
    }
  }
  if(outroT>0) drawResultCard(ctx,w,h,outroT,card);
}

function stageOf(t: number): number {
  if (t < 0.27) return 0;
  if (t < 0.53) return 1;
  if (t < 0.77) return 2;
  return 3;
}

// ─── Component ────────────────────────────────────────────────────────────────
interface Props { scene: AnimationScene; data?: ForecastResult; onComplete: () => void; }

export default function EngineAnimation({ scene, data, onComplete }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef    = useRef<number>(0);
  const startRef  = useRef<number|null>(null);
  const [stage,   setStage]   = useState(0);
  const [inOutro, setInOutro] = useState(false);
  const [done,    setDone]    = useState(false);
  const [spendPaycheckVisible, setSpendPaycheckVisible] = useState(false);
  const [curNarrator, setCurNarrator] = useState<NarrationStep | null>(null);
  const lastNarratorRef = useRef<NarrationStep | null>(null);

  const ex   = useMemo(()=>extract(scene,data),[scene,data]);
  const subs = useMemo(()=>subtitles(scene,ex),[scene,ex]);
  const card = useMemo(()=>resultCard(scene,ex),[scene,ex]);

  // Canvas text can intermittently lose a glyph during a phase repaint in some
  // browsers. These two labels sit on canvas-drawn markers, so keep the marker
  // geometry there and render only the text in a stable DOM layer.
  const spendMarker = scene === "spend" && !inOutro
    ? stage === 3 && spendPaycheckVisible
      ? { label: "+$1,200 Paycheck", tone: "is-paycheck", top: (() => {
          const safeDaily = ex.safeWeekly / 7;
          const balance = 1360 - safeDaily * 15;
          const pointY = balance >= 0
            ? 296 - (balance / 2200) * 192
            : 296 + (Math.abs(balance) / 400) * 56;
          return pointY - 20;
        })() }
      : { label: "DAY 3 LOW · -$240", tone: "is-risk", top: 300 }
    : null;

  // Keyboard shortcut: Escape or Space to skip
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onComplete();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onComplete]);

  useEffect(()=>{
    const canvas=canvasRef.current; if(!canvas) return;
    const ctx=canvas.getContext("2d"); if(!ctx) return;
    startRef.current=null; setStage(0); setInOutro(false); setDone(false); setSpendPaycheckVisible(false);
    lastNarratorRef.current = null; setCurNarrator(null);

    function resize(){
      if(!canvas) return;
      const r=canvas.getBoundingClientRect(), dpr=window.devicePixelRatio||1;
      canvas.width=r.width*dpr; canvas.height=r.height*dpr; ctx!.scale(dpr,dpr);
    }
    resize();
    const ro=new ResizeObserver(resize); ro.observe(canvas);

    function frame(now: number){
      if(!canvas) return;
      if(startRef.current===null) startRef.current=now;
      const elapsed=now-startRef.current;
      const t=clamp(elapsed/MAIN_MS,0,1);
      const outroT=t>=1?clamp((elapsed-MAIN_MS)/OUTRO_MS,0,1):0;
      const fadeInT=clamp(elapsed/FADE_IN_MS,0,1);
      const r=canvas.getBoundingClientRect();
      const outroActive = t >= 1;

      if(t<1){setStage(stageOf(t));setInOutro(false);}
      else{setStage(4);setInOutro(true);}
      setSpendPaycheckVisible(scene === "spend" && smooth(0.76, 0.94, t) >= 14 / 29);

      // Update DOM narrator step only when title or detail changes
      const nextStep = outroActive ? null : getNarrationStep(scene, ex, t);
      if (nextStep?.title !== lastNarratorRef.current?.title || nextStep?.detail !== lastNarratorRef.current?.detail) {
        lastNarratorRef.current = nextStep;
        setCurNarrator(nextStep);
      }

      paintFrame(ctx!,scene,r.width,r.height,t,outroT,fadeInT,ex,card);
      if(outroT<1) rafRef.current=requestAnimationFrame(frame);
      else setDone(true);
    }
    rafRef.current=requestAnimationFrame(frame);
    return()=>{cancelAnimationFrame(rafRef.current);ro.disconnect();};
  },[scene,ex,card]);

  useEffect(()=>{
    if(!done) return;
    const id=setTimeout(onComplete,120); return()=>clearTimeout(id);
  },[done,onComplete]);

  const sub=subs[Math.min(stage, STEP_COUNT - 1)];

  return(
    <div className={`eng-anim${inOutro?" is-outro":""}`}>
      {/* Clean Engineering Step Card at Top */}
      <div className="eng-anim__narrator-wrap">
        <AnimatePresence mode="wait">
          {curNarrator && !inOutro && (
            <motion.div
              key={curNarrator.title}
              className="eng-anim__narrator-card"
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.28, ease: "easeOut" }}
            >
              <span className="eng-anim__narrator-step">STEP {curNarrator.step}</span>
              <div className="eng-anim__narrator-content">
                <span className="eng-anim__narrator-title">{curNarrator.title}</span>
                {curNarrator.detail && (
                  <span className="eng-anim__narrator-detail">{curNarrator.detail}</span>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <canvas ref={canvasRef} className="eng-anim__canvas" aria-hidden="true"/>

      {spendMarker && (
        <div
          className={`eng-anim__spend-marker ${spendMarker.tone}`}
          style={{ top: `${spendMarker.top}px` }}
          aria-hidden="true"
        >
          {spendMarker.label}
        </div>
      )}

      <div className={`eng-anim__hud${inOutro?" is-outro":""}`}>
        <div className="eng-anim__badge" style={inOutro?{background:"rgba(23,107,85,0.1)",borderColor:"rgba(23,107,85,0.25)",color:L.safe}:{}}>
          <span className="eng-anim__badge-dot" style={inOutro?{background:L.safe}:{}}/>
          Overcast Engine
        </div>
        <AnimatePresence mode="wait">
          <motion.p key={sub} className={`eng-anim__subtitle${inOutro?" is-outro":""}`}
            initial={{opacity:0,y:5}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-5}} transition={{duration:0.28}}>
            {sub}
          </motion.p>
        </AnimatePresence>
        <div className="eng-anim__dots" aria-hidden="true">
          {Array.from({ length: STEP_COUNT }, (_, i) => (
            <span key={i} className={`eng-anim__dot${i <= Math.min(stage, 3) ? " is-active" : ""}`} />
          ))}
        </div>
        {!inOutro && (
          <button
            type="button"
            className="eng-anim__skip-btn"
            onClick={onComplete}
            title="Skip to results (or press Esc)"
          >
            Skip <span>→</span>
          </button>
        )}
      </div>
    </div>
  );
}
