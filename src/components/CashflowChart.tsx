"use client";

import { useId, useMemo, useState } from "react";
import type { ForecastDay, ForecastResult } from "@/lib/forecast";

type ChartMode = "forecast" | "comparison" | "safe";

type CashflowChartProps = {
  data: ForecastResult;
  comparisonData?: ForecastResult | null;
  mode?: ChartMode;
  showConfidence?: boolean;
  compact?: boolean;
  label?: string;
};

function money(value: number, digits = 0) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

function dateLabel(value: string | undefined) {
  if (!value) return "Date unavailable";
  const date = new Date(value.includes("T") ? value : `${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function smoothLine(points: Array<{ x: number; y: number }>) {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  return points.reduce(
    (path, point, index) => index === 0
      ? `M ${point.x.toFixed(2)} ${point.y.toFixed(2)}`
      : `${path} L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
    "",
  );
}

function areaBetween(
  top: Array<{ x: number; y: number }>,
  bottom: Array<{ x: number; y: number }>,
) {
  if (top.length === 0 || bottom.length === 0) return "";
  const forward = smoothLine(top);
  const reverse = [...bottom].reverse();
  const back = smoothLine(reverse).replace(/^M/, "L");
  return `${forward} ${back} Z`;
}

function peakRisk(data: ForecastResult) {
  return Math.max(0, ...data.series.map((day) => day.overdraftProbability ?? 0));
}

function getMeaningfulEvents(series: ForecastDay[]) {
  return series
    .flatMap((day, index) => day.events.map((event) => ({ day, index, event })))
    .filter(({ event }) => !event.isEstimated)
    .sort((left, right) => right.event.amount - left.event.amount)
    .slice(0, 4)
    .sort((left, right) => left.index - right.index);
}

export default function CashflowChart({
  data,
  comparisonData = null,
  mode = "forecast",
  showConfidence = true,
  compact = false,
  label = "Projected account balance over the next 30 days",
}: CashflowChartProps) {
  const id = useId().replace(/:/g, "");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const width = 920;
  const height = compact ? 230 : 360;
  const left = 48;
  const right = 24;
  const top = 28;
  const bottom = compact ? 34 : 52;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;

  const chart = useMemo(() => {
    const allSeries = comparisonData ? [...data.series, ...comparisonData.series] : data.series;
    const rawValues = allSeries.flatMap((day) => [
      day.balance,
      day.confidenceLow ?? day.balance,
      day.confidenceHigh ?? day.balance,
    ]);
    rawValues.push(data.buffer, 0);
    const rawMin = Math.min(...rawValues, 0);
    const rawMax = Math.max(...rawValues, 1);
    const span = Math.max(100, rawMax - rawMin);
    const padding = span * 0.14;
    const domainMin = rawMin - padding;
    const domainMax = rawMax + padding;
    const x = (index: number) => left + (index / Math.max(1, data.series.length - 1)) * plotWidth;
    const y = (value: number) => top + ((domainMax - value) / (domainMax - domainMin)) * plotHeight;
    const points = data.series.map((day, index) => ({ x: x(index), y: y(day.balance) }));
    const confidenceHigh = data.series.map((day, index) => ({ x: x(index), y: y(day.confidenceHigh ?? day.balance) }));
    const confidenceLow = data.series.map((day, index) => ({ x: x(index), y: y(day.confidenceLow ?? day.balance) }));
    const comparison = comparisonData?.series.map((day, index) => ({ x: x(index), y: y(day.balance) })) ?? [];
    const dangerIndex = data.series.reduce((lowest, day, index, list) => day.balance < list[lowest].balance ? index : lowest, 0);
    return {
      x,
      y,
      zeroY: y(data.buffer),
      points,
      line: smoothLine(points),
      confidence: areaBetween(confidenceHigh, confidenceLow),
      comparisonLine: smoothLine(comparison),
      dangerIndex,
      events: getMeaningfulEvents(data.series),
      domainMin,
      domainMax,
      ticks: [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
        y: top + ratio * plotHeight,
        value: domainMax - ratio * (domainMax - domainMin),
      })),
    };
  }, [comparisonData, data, plotHeight, plotWidth]);

  const inspectedIndex = selectedIndex ?? chart.dangerIndex;
  const inspectedDay = data.series[inspectedIndex];
  const inspectedX = chart.x(inspectedIndex);
  const inspectedY = chart.y(inspectedDay?.balance ?? 0);
  const chartRisk = peakRisk(data);

  return (
    <figure className={`cashflow-chart ${compact ? "is-compact" : ""}`} aria-label={label}>
      <div className="cashflow-chart__canvas">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${id}-title ${id}-description`}>
          <title id={`${id}-title`}>{label}</title>
          <desc id={`${id}-description`}>
            The projected balance reaches a low of {money(data.series[chart.dangerIndex]?.balance ?? 0)} on {dateLabel(data.series[chart.dangerIndex]?.date)}.
          </desc>
          <defs>
            <linearGradient id={`${id}-safe`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.14" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0.0" />
            </linearGradient>
            <linearGradient id={`${id}-risk`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#f43f5e" stopOpacity="0.0" />
              <stop offset="100%" stopColor="#f43f5e" stopOpacity="0.15" />
            </linearGradient>
            <clipPath id={`${id}-above`}><rect x="0" y="0" width={width} height={Math.max(0, chart.zeroY)} /></clipPath>
            <clipPath id={`${id}-below`}><rect x="0" y={chart.zeroY} width={width} height={Math.max(0, height - chart.zeroY)} /></clipPath>
          </defs>

          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
            <line key={`x-${ratio}`} x1={left + ratio * plotWidth} x2={left + ratio * plotWidth} y1={top} y2={height - bottom} className="cashflow-chart__grid" />
          ))}
          {chart.ticks.map((tick, index) => (
            <g key={`y-${index}`}>
              <line x1={left} x2={width - right} y1={tick.y} y2={tick.y} className="cashflow-chart__grid is-horizontal" />
              {!compact && <text x={left - 10} y={tick.y + 4} textAnchor="end" className="cashflow-chart__axis-label">{money(tick.value)}</text>}
            </g>
          ))}

          {showConfidence && <path d={chart.confidence} className="cashflow-chart__confidence" />}
          <path d={`${chart.line} L ${width - right} ${chart.zeroY} L ${left} ${chart.zeroY} Z`} fill={`url(#${id}-safe)`} clipPath={`url(#${id}-above)`} />
          <path d={`${chart.line} L ${width - right} ${chart.zeroY} L ${left} ${chart.zeroY} Z`} fill={`url(#${id}-risk)`} clipPath={`url(#${id}-below)`} />
          <line x1={left} x2={width - right} y1={chart.zeroY} y2={chart.zeroY} className="cashflow-chart__waterline" />
          <text x={left + 10} y={Math.max(top + 14, chart.zeroY - 8)} className="cashflow-chart__waterline-label">$0 WATERLINE</text>

          {comparisonData && <path d={chart.line} className="cashflow-chart__line is-before" />}
          <path d={comparisonData ? chart.comparisonLine : chart.line} className={`cashflow-chart__line ${comparisonData || mode === "safe" ? "is-after" : ""}`} />
          {!comparisonData && <path d={chart.line} className="cashflow-chart__line is-risk" clipPath={`url(#${id}-below)`} />}

          {!compact && chart.events.map(({ day, event, index }) => {
            const pointX = chart.x(index);
            const pointY = chart.y(day.balance);
            return <g key={`${day.date}-${event.name}`} className={event.isIncome ? "cashflow-chart__event is-income" : "cashflow-chart__event"}>
              <line x1={pointX} x2={pointX} y1={pointY - 13} y2={pointY + 13} />
              <circle cx={pointX} cy={pointY} r="4" />
            </g>;
          })}

          {inspectedDay && <g className="cashflow-chart__focus">
            <line x1={inspectedX} x2={inspectedX} y1={top} y2={height - bottom} />
            <circle cx={inspectedX} cy={inspectedY} r="11" className="cashflow-chart__focus-halo" />
            <circle cx={inspectedX} cy={inspectedY} r="5" className={inspectedDay.balance < data.buffer ? "is-danger" : "is-safe"} />
          </g>}

          {data.series.map((day, index) => (
            <rect
              key={day.date}
              x={chart.x(index) - plotWidth / Math.max(data.series.length - 1, 1) / 2}
              y={top}
              width={plotWidth / Math.max(data.series.length - 1, 1)}
              height={plotHeight}
              fill="transparent"
              className="cashflow-chart__hit"
              onPointerEnter={() => setSelectedIndex(index)}
              onFocus={() => setSelectedIndex(index)}
              tabIndex={index === chart.dangerIndex ? 0 : -1}
              aria-label={`${dateLabel(day.date)}, ${money(day.balance)}`}
            />
          ))}
        </svg>

        {inspectedDay && !compact && (
          <div
            className={`cashflow-chart__callout ${inspectedDay.balance < data.buffer ? "is-danger" : "is-safe"} ${inspectedX < width * 0.25 ? "is-near-left" : inspectedX > width * 0.75 ? "is-near-right" : ""}`}
            style={{
              left: `${(inspectedX / width) * 100}%`,
              top: `${Math.min(72, Math.max(12, (inspectedY / height) * 100 - 15))}%`,
            }}
          >
            <span>{dateLabel(inspectedDay.date)}</span>
            <strong>{money(inspectedDay.balance)}</strong>
            <small>{Math.round((inspectedDay.overdraftProbability ?? chartRisk) * 100)}% risk on this day</small>
          </div>
        )}
      </div>

      <div className="cashflow-chart__axis" aria-hidden="true">
        <span>{dateLabel(data.series[0]?.date)}</span>
        <span>{dateLabel(data.series[Math.floor(data.series.length / 2)]?.date)}</span>
        <span>{dateLabel(data.series.at(-1)?.date)}</span>
      </div>

      {!compact && (
        <figcaption className="cashflow-chart__legend">
          <span><i className="is-projection" /> Expected balance</span>
          {showConfidence && <span><i className="is-confidence" /> {(data.risk?.calibrationWindows ?? 0) > 0 ? "Calibrated range" : "Modeled range"}</span>}
          {comparisonData && <span><i className="is-before" /> Before plan</span>}
          <span><i className="is-waterline" /> Overdraft threshold</span>
        </figcaption>
      )}
    </figure>
  );
}
