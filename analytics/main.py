"""Overcast's calibrated cash-flow digital twin.

This service owns statistical inference and decision optimization. It receives
only normalized transaction data from the Next.js server, never Plaid access
tokens, and returns reproducible forecast artifacts for the connected account.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from math import ceil
from typing import Literal

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sklearn.ensemble import GradientBoostingClassifier, GradientBoostingRegressor

MODEL_VERSION = "cashflow-digital-twin-v1"
SIMULATION_COUNT = 10_000
RISK_TARGET = 0.05
MIN_TRAINING_DAYS = 28

app = FastAPI(title="Overcast Analytics", version=MODEL_VERSION)


class Stream(BaseModel):
    name: str
    amount: float = Field(ge=0)
    cadence_days: int = Field(ge=1, le=366)
    is_income: bool
    first_day: int = Field(ge=1, le=90)
    is_estimated: bool = False


class Transaction(BaseModel):
    amount: float
    posted_date: date
    description: str = ""
    primary_category: str | None = None
    detailed_category: str | None = None

class PendingTransaction(BaseModel):
    amount: float
    authorized_date: date
    description: str = "Pending transaction"


class ForecastRequest(BaseModel):
    starting_balance: float
    buffer: float = 0
    horizon_days: int = Field(default=30, ge=1, le=90)
    start_date: date
    streams: list[Stream]
    transactions: list[Transaction]
    savings_available: float = Field(default=0, ge=0)
    risk_target: float = Field(default=RISK_TARGET, gt=0, le=0.5)
    pending_transactions: list[PendingTransaction] = []
    available_balance: float | None = None
    current_balance: float | None = None


def iso(day: date) -> str:
    return day.isoformat()


def daily_spend_frame(transactions: list[Transaction], anchor: date) -> pd.DataFrame:
    """Produces a complete calendar ledger, retaining zero-spend days."""
    rows = [
        {
            "date": pd.Timestamp(transaction.posted_date),
            "amount": max(0.0, transaction.amount),
            "category": (transaction.primary_category or transaction.detailed_category or "other").lower(),
        }
        for transaction in transactions
        if transaction.amount > 0 and transaction.posted_date <= anchor
    ]
    if not rows:
        return pd.DataFrame(columns=["date", "spend", "weekday", "recent_7", "recent_28", "payday_distance"])
    raw = pd.DataFrame(rows)
    start = raw["date"].min().date()
    index = pd.date_range(start, anchor, freq="D")
    totals = raw.groupby("date", as_index=True)["amount"].sum().reindex(index, fill_value=0.0)
    frame = pd.DataFrame({"date": index, "spend": totals.to_numpy(dtype=float)})
    frame["weekday"] = frame["date"].dt.dayofweek
    frame["recent_7"] = frame["spend"].shift(1).rolling(7, min_periods=1).mean().fillna(0.0)
    frame["recent_28"] = frame["spend"].shift(1).rolling(28, min_periods=1).mean().fillna(0.0)
    category_totals = raw.pivot_table(index="date", columns="category", values="amount", aggfunc="sum", fill_value=0.0)
    # Keep category signal compact and stable even with merchant-level noise.
    top_categories = list(category_totals.sum().sort_values(ascending=False).head(4).index)
    for category in top_categories:
        frame[f"cat_{category}"] = category_totals.reindex(index, fill_value=0.0)[category].to_numpy(dtype=float)
    return frame


def payday_distances(days: pd.Series, streams: list[Stream], anchor: date) -> np.ndarray:
    income_days: list[date] = []
    horizon = max(120, len(days) + 60)
    for stream in streams:
        if not stream.is_income:
            continue
        for offset in range(stream.first_day, horizon + 1, stream.cadence_days):
            income_days.append(anchor + timedelta(days=offset))
        # Historical recurrence dates give the learner a payroll-proximity feature.
        for offset in range(stream.first_day - stream.cadence_days, -horizon, -stream.cadence_days):
            income_days.append(anchor + timedelta(days=offset))
    if not income_days:
        return np.full(len(days), 14.0)
    return np.array([min(abs((payday - day.date()).days) for payday in income_days) for day in days], dtype=float)


def feature_frame(frame: pd.DataFrame, streams: list[Stream], anchor: date) -> tuple[pd.DataFrame, list[str]]:
    result = frame.copy()
    result["payday_distance"] = payday_distances(result["date"], streams, anchor)
    weekdays = pd.get_dummies(result["weekday"], prefix="weekday", dtype=float)
    result = pd.concat([result, weekdays], axis=1)
    feature_names = [column for column in result.columns if column not in {"date", "spend", "weekday"}]
    return result, feature_names


def fit_quantile_models(frame: pd.DataFrame, feature_names: list[str]) -> tuple[dict[float, GradientBoostingRegressor] | None, GradientBoostingClassifier | None, np.ndarray, str]:
    if len(frame) < MIN_TRAINING_DAYS:
        return None, None, frame["spend"].to_numpy(dtype=float), "weekday-bootstrap"
    x = frame[feature_names].to_numpy(dtype=float)
    y = frame["spend"].to_numpy(dtype=float)
    models: dict[float, GradientBoostingRegressor] = {}
    for alpha in (0.1, 0.5, 0.9):
        model = GradientBoostingRegressor(
            loss="quantile",
            alpha=alpha,
            n_estimators=90,
            learning_rate=0.045,
            max_depth=2,
            min_samples_leaf=max(3, min(10, len(frame) // 10)),
            random_state=41,
        )
        model.fit(x, y)
        models[alpha] = model
    occurrence = (y > 0).astype(int)
    occurrence_model = None
    if len(np.unique(occurrence)) > 1:
        occurrence_model = GradientBoostingClassifier(n_estimators=70, learning_rate=0.05, max_depth=2, min_samples_leaf=max(3, len(frame) // 12), random_state=43)
        occurrence_model.fit(x, occurrence)
    median_fit = models[0.5].predict(x)
    return models, occurrence_model, y - median_fit, "occurrence-plus-gradient-boosted-quantile"


def rolling_calibration(frame: pd.DataFrame, feature_names: list[str]) -> tuple[float, int, float, float]:
    """Rolling-origin conformal radius. Small histories return an honest zero."""
    if len(frame) < MIN_TRAINING_DAYS + 14:
        return 0.0, 0, 0.0, 0.0
    errors: list[float] = []
    # Ten separated origins keep a demo request fast while remaining true
    # out-of-sample estimates at each origin.
    origins = np.linspace(MIN_TRAINING_DAYS, len(frame) - 1, num=min(10, len(frame) - MIN_TRAINING_DAYS), dtype=int)
    for origin in np.unique(origins):
        train = frame.iloc[:origin]
        x_train = train[feature_names].to_numpy(dtype=float)
        y_train = train["spend"].to_numpy(dtype=float)
        if len(train) < MIN_TRAINING_DAYS:
            continue
        model = GradientBoostingRegressor(loss="squared_error", n_estimators=55, learning_rate=0.05, max_depth=2, min_samples_leaf=4, random_state=origin)
        model.fit(x_train, y_train)
        for target in range(origin, min(origin + 7, len(frame))):
            actual = float(frame.iloc[target]["spend"])
            predicted = float(model.predict(frame.iloc[[target]][feature_names].to_numpy(dtype=float))[0])
            errors.append(abs(actual - predicted))
    if not errors:
        return 0.0, 0, 0.0, 0.0
    radius = float(np.quantile(np.asarray(errors), 0.8))
    return radius, len(np.unique(origins)), float(np.mean(np.asarray(errors) <= radius)), float(np.mean(errors))


def spending_drift(frame: pd.DataFrame) -> dict:
    """Detect a sustained change before trusting a stale spending pattern."""
    spend = frame["spend"].to_numpy(dtype=float)
    if len(spend) < 28:
        return {"status": "limited_history", "recentDailySpend": round(float(np.mean(spend)) if len(spend) else 0.0, 2), "priorDailySpend": None, "change": None}
    recent = float(np.mean(spend[-28:]))
    prior = float(np.mean(spend[-56:-28])) if len(spend) >= 56 else recent
    change = (recent - prior) / max(prior, 1.0)
    status = "elevated" if abs(change) >= 0.35 else "watch" if abs(change) >= 0.18 else "stable"
    return {"status": status, "recentDailySpend": round(recent, 2), "priorDailySpend": round(prior, 2), "change": round(change, 4)}


def deterministic_events(request: ForecastRequest) -> tuple[np.ndarray, list[list[dict]]]:
    deltas = np.zeros(request.horizon_days, dtype=float)
    events: list[list[dict]] = [[] for _ in range(request.horizon_days)]
    for stream in request.streams:
        if stream.is_estimated:
            continue
        for day_offset in range(stream.first_day, request.horizon_days + 1, stream.cadence_days):
            signed = stream.amount if stream.is_income else -stream.amount
            deltas[day_offset - 1] += signed
            events[day_offset - 1].append({"name": stream.name, "amount": round(stream.amount, 2), "isIncome": stream.is_income, "isEstimated": False})
    return deltas, events


def forecast_spending(frame: pd.DataFrame, models: dict[float, GradientBoostingRegressor] | None, occurrence_model: GradientBoostingClassifier | None, feature_names: list[str], streams: list[Stream], anchor: date, horizon: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    working = frame.copy()
    forecast_median: list[float] = []
    forecast_low: list[float] = []
    forecast_high: list[float] = []
    occurrence_probability: list[float] = []
    history = list(working["spend"].to_numpy(dtype=float))
    for offset in range(1, horizon + 1):
        future = anchor + timedelta(days=offset)
        row: dict[str, float | pd.Timestamp] = {
            "date": pd.Timestamp(future),
            "weekday": future.weekday(),
            "recent_7": float(np.mean(history[-7:])) if history else 0.0,
            "recent_28": float(np.mean(history[-28:])) if history else 0.0,
            "payday_distance": float(payday_distances(pd.Series([pd.Timestamp(future)]), streams, anchor)[0]),
        }
        for column in feature_names:
            if column.startswith("cat_"):
                row[column] = 0.0
            elif column.startswith("weekday_"):
                row[column] = 1.0 if column == f"weekday_{future.weekday()}" else 0.0
        features = np.array([[float(row.get(column, 0.0)) for column in feature_names]], dtype=float)
        if models:
            low = max(0.0, float(models[0.1].predict(features)[0]))
            median = max(0.0, float(models[0.5].predict(features)[0]))
            high = max(median, float(models[0.9].predict(features)[0]))
            probability = float(occurrence_model.predict_proba(features)[0][1]) if occurrence_model else 1.0
        else:
            pool = working.loc[working["weekday"] == future.weekday(), "spend"].to_numpy(dtype=float)
            if len(pool) < 3:
                pool = working["spend"].to_numpy(dtype=float)
            low, median, high = (float(np.quantile(pool, q)) for q in (0.1, 0.5, 0.9))
            probability = float(np.mean(pool > 0))
        # The quantile model learns magnitude; the classifier independently
        # learns whether a variable-spending day occurs at all.
        low, median, high = low * probability, median * probability, high * probability
        forecast_low.append(low)
        forecast_median.append(median)
        forecast_high.append(high)
        occurrence_probability.append(probability)
        history.append(median)
    return np.asarray(forecast_low), np.asarray(forecast_median), np.asarray(forecast_high), np.asarray(occurrence_probability)


def simulate_paths(starting_balance: float, deterministic_delta: np.ndarray, median_spend: np.ndarray, residuals: np.ndarray, calibration_radius: float, seed: int, streams: list[Stream], pending_transactions: list[PendingTransaction]) -> np.ndarray:
    rng = np.random.default_rng(seed)
    horizon = len(deterministic_delta)
    if len(residuals) < 4:
        residuals = np.array([-15.0, -5.0, 0.0, 5.0, 15.0])
    shocks = rng.choice(residuals, size=(SIMULATION_COUNT, horizon), replace=True)
    if calibration_radius:
        shocks += rng.uniform(-calibration_radius, calibration_radius, size=(SIMULATION_COUNT, horizon))
    variable_spend = np.maximum(0.0, median_spend[np.newaxis, :] + shocks)
    timing_delta = np.tile(deterministic_delta, (SIMULATION_COUNT, 1))
    # Known cash flows stay in the expected line, while each future path
    # permits a one-day early/on-time/late clearing outcome. This makes timing
    # gaps visible without pretending the amount of rent or payroll is random.
    for stream in streams:
        if stream.is_estimated:
            continue
        signed = stream.amount if stream.is_income else -stream.amount
        for day in range(stream.first_day, len(deterministic_delta) + 1, stream.cadence_days):
            shifts = rng.choice(np.array([-1, 0, 1]), size=SIMULATION_COUNT, p=np.array([0.15, 0.7, 0.15]))
            timing_delta[:, day - 1] -= signed
            rows = np.arange(SIMULATION_COUNT)
            target = np.clip(day - 1 + shifts, 0, len(deterministic_delta) - 1)
            timing_delta[rows, target] += signed
    # Pending transactions are already visible to the bank but have not
    # necessarily settled. Charges land in 1-3 days; pending credits land in
    # 1-2 days. Current balance is the starting point, so this is the one
    # place their value enters the paths.
    for transaction in pending_transactions:
        amount = transaction.amount
        is_outgoing = transaction.amount > 0
        # Restaurants, bars, hotels, and fuel purchases can settle above the
        # authorization because of tips, holds, or final-metered amounts.
        if transaction.amount > 0 and any(token in transaction.description.lower() for token in ("gas", "fuel", "restaurant", "cafe", "bar", "hotel", "ride")):
            amount *= rng.uniform(1.0, 1.20, size=SIMULATION_COUNT)
        signed = -amount
        settle_day = rng.choice(np.array([1, 2, 3] if is_outgoing else [1, 2]), size=SIMULATION_COUNT, p=np.array([0.45, 0.35, 0.20] if is_outgoing else [0.6, 0.4]))
        rows = np.arange(SIMULATION_COUNT)
        targets = np.minimum(settle_day - 1, horizon - 1)
        # If a credit and a debit settle on the same day, the debit can clear
        # first. Half of these paths charge it one day earlier, preserving a
        # conservative intra-day clearing-order risk.
        same_day_credit = deterministic_delta[targets] > 0
        early = is_outgoing & same_day_credit & (rng.random(SIMULATION_COUNT) < 0.5) & (targets > 0)
        targets = np.where(early, targets - 1, targets)
        timing_delta[rows, targets] += signed
    return starting_balance + np.cumsum(timing_delta - variable_spend, axis=1)


def risk_summary(paths: np.ndarray, buffer: float) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    return (
        np.quantile(paths, 0.5, axis=0),
        np.quantile(paths, 0.1, axis=0),
        np.quantile(paths, 0.9, axis=0),
        np.mean(paths < buffer, axis=0),
    )


def deferred_delta(delta: np.ndarray, streams: list[Stream], stream_name: str, defer_days: int) -> np.ndarray:
    changed = delta.copy()
    for stream in streams:
        if stream.name != stream_name or stream.is_income or stream.is_estimated:
            continue
        for day_offset in range(stream.first_day, len(delta) + 1, stream.cadence_days):
            changed[day_offset - 1] += stream.amount
            shifted = day_offset + defer_days
            if shifted <= len(delta):
                changed[shifted - 1] -= stream.amount
    return changed


def optimize(paths: np.ndarray, request: ForecastRequest, delta: np.ndarray, median_spend: np.ndarray) -> dict:
    """Search a transparent set of constrained actions over common paths."""
    base_risk = float(np.mean(np.min(paths, axis=1) < request.buffer))
    # Candidates adjust the original simulated paths directly. This preserves
    # each path's sampled spending and early/on-time/late cash-flow timing,
    # rather than trying to reconstruct those two sources of uncertainty.
    candidates: list[dict] = []
    min_path = np.min(paths, axis=1)
    required = max(0.0, float(np.quantile(request.buffer - min_path, 1.0 - request.risk_target)))
    # Search both amount and timing. A later transfer is only valid when no
    # prior simulated path crosses the waterline before it arrives.
    for transfer_day in (1, 2, 3, 5):
        prior = np.min(paths[:, :transfer_day], axis=1)
        required = max(0.0, float(np.quantile(request.buffer - prior, 1.0 - request.risk_target)))
        if required > 0 and request.savings_available >= required:
            shifted = paths.copy()
            shifted[:, transfer_day - 1:] += required
            risk = float(np.mean(np.min(shifted, axis=1) < request.buffer))
            if risk <= request.risk_target:
                candidates.append({
                    "type": "transfer", "amount": round(required + 0.01, 2), "day": transfer_day, "risk": risk,
                    "burden": required + (transfer_day - 1) * 3,
                    "explanation": "Minimum transfer and earliest safe timing that protect the same simulated futures.",
                })
    for stream in request.streams:
        if stream.is_income or stream.is_estimated or stream.first_day > len(delta):
            continue
        for days in (1, 3, 5, 7):
            revised_delta = deferred_delta(delta, request.streams, stream.name, days)
            revised_paths = paths + np.cumsum((revised_delta - delta)[np.newaxis, :], axis=1)
            risk = float(np.mean(np.min(revised_paths, axis=1) < request.buffer))
            if risk <= request.risk_target:
                candidates.append({
                    "type": "defer", "streamName": stream.name, "days": days, "amount": round(stream.amount, 2), "risk": risk,
                    "burden": stream.amount * 0.08 + days * 8,
                    "explanation": "Defers one known bill while preserving the exact same simulated spending futures.",
                })
            # A constrained two-action plan: defer the bill, then transfer
            # only the remaining shortfall. This is evaluated on identical
            # paths, never a newly sampled alternate future.
            deferred_min = np.min(revised_paths, axis=1)
            combo_required = max(0.0, float(np.quantile(request.buffer - deferred_min, 1.0 - request.risk_target)))
            if 0 < combo_required <= request.savings_available:
                combo_paths = revised_paths + combo_required
                combo_risk = float(np.mean(np.min(combo_paths, axis=1) < request.buffer))
                if combo_risk <= request.risk_target:
                    candidates.append({
                        "type": "combo", "amount": round(combo_required + 0.01, 2), "streamName": stream.name, "days": days, "risk": combo_risk,
                        "burden": combo_required + stream.amount * 0.04 + days * 4,
                        "explanation": "Combines the smallest savings transfer with the shortest viable bill deferral.",
                    })
    # Discretionary reduction is evaluated against the same residual paths.
    for reduction in (0.10, 0.20, 0.30, 0.40):
        reduced_paths = paths + np.cumsum((median_spend * reduction)[np.newaxis, :], axis=1)
        risk = float(np.mean(np.min(reduced_paths, axis=1) < request.buffer))
        if risk <= request.risk_target:
            monthly = float(np.sum(median_spend) * reduction)
            candidates.append({
                "type": "reduce_spending", "percent": round(reduction * 100), "amount": round(monthly, 2), "risk": risk,
                "burden": monthly * 0.72,
                "explanation": "Reduces forecast variable spending across the same modeled scenarios.",
            })
    # Exhaustive search over the bounded, user-actionable combination space.
    # Every bill, practical deferral, reduction level, and transfer day is
    # evaluated on the identical paths; the transfer amount is solved exactly
    # from the required lower-tail cushion for that candidate.
    for stream in request.streams:
        if stream.is_income or stream.is_estimated or stream.first_day > len(delta):
            continue
        for defer_days in (1, 3, 5, 7):
            shifted_delta = deferred_delta(delta, request.streams, stream.name, defer_days)
            for reduction in (0.0, 0.10, 0.20, 0.30, 0.40):
                candidate_paths = paths + np.cumsum((shifted_delta - delta + median_spend * reduction)[np.newaxis, :], axis=1)
                for transfer_day in (1, 2, 3, 5):
                    prior = np.min(candidate_paths[:, :transfer_day], axis=1)
                    amount = max(0.0, float(np.quantile(request.buffer - prior, 1.0 - request.risk_target)))
                    if amount <= 0 or amount > request.savings_available:
                        continue
                    protected = candidate_paths.copy()
                    protected[:, transfer_day - 1:] += amount
                    risk = float(np.mean(np.min(protected, axis=1) < request.buffer))
                    if risk <= request.risk_target:
                        candidates.append({
                            "type": "combo", "amount": round(amount + 0.01, 2), "day": transfer_day,
                            "streamName": stream.name, "days": defer_days, "percent": round(reduction * 100),
                            "risk": risk,
                            "burden": amount + stream.amount * 0.04 + defer_days * 4 + reduction * np.sum(median_spend) * 0.72,
                            "explanation": "Exhaustive bounded combination of bill timing, spending reduction, and scheduled savings transfer.",
                        })
    candidates.sort(key=lambda candidate: candidate["burden"])
    chosen = candidates[0] if candidates else None
    # Keep a tiny Pareto-style frontier: least disruption, least cash moved,
    # and strongest safety margin. Deduplication avoids three copies of the
    # same action while preserving explainable alternatives for the UI.
    alternatives: list[dict] = []
    for candidate in ([candidates[0]] if candidates else []) + sorted(candidates, key=lambda candidate: candidate["amount"])[:1] + sorted(candidates, key=lambda candidate: candidate["risk"])[:1]:
        key = (candidate["type"], candidate.get("streamName"), candidate.get("days"), candidate.get("percent"), candidate.get("day"), candidate["amount"])
        if not any((existing["type"], existing.get("streamName"), existing.get("days"), existing.get("percent"), existing.get("day"), existing["amount"]) == key for existing in alternatives):
            alternatives.append(candidate)
    return {
        "riskTarget": request.risk_target,
        "beforeRisk": base_risk,
        "recommended": chosen,
        "alternatives": alternatives,
        "candidateCount": len(candidates),
        "status": "solved" if chosen else "no_single_action_found",
    }


def distributionally_robust_paths(paths: np.ndarray, median_spend: np.ndarray, streams: list[Stream]) -> tuple[np.ndarray, list[str]]:
    """Build an ambiguity set around the learned distribution, then retain
    the pathwise lower envelope. A candidate must survive every member of the
    set, not merely a single high-spend draw."""
    horizon = paths.shape[1]
    scenarios = [paths]
    labels = ["learned distribution"]
    for multiplier in (1.15, 1.30, 1.50):
        scenarios.append(paths - np.cumsum((median_spend * (multiplier - 1))[np.newaxis, :], axis=1))
        labels.append(f"{round((multiplier - 1) * 100)}% higher variable spending")
    front_loaded = np.zeros(horizon, dtype=float)
    front_loaded[: min(7, horizon)] = median_spend[: min(7, horizon)] * 0.40
    scenarios.append(paths - np.cumsum(front_loaded[np.newaxis, :], axis=1))
    labels.append("front-loaded first-week spending")
    timing_delta = np.zeros(horizon, dtype=float)
    for stream in streams:
        if stream.is_estimated:
            continue
        signed = stream.amount if stream.is_income else -stream.amount
        for day in range(stream.first_day, horizon + 1, stream.cadence_days):
            # Income clears one day later, bills one day earlier.
            if stream.is_income and day < horizon:
                timing_delta[day - 1] -= signed
                timing_delta[day] += signed
            elif not stream.is_income and day > 1:
                timing_delta[day - 2] += signed
                timing_delta[day - 1] -= signed
    scenarios.append(paths + np.cumsum(timing_delta[np.newaxis, :], axis=1))
    labels.append("adverse clearing timing")
    return np.minimum.reduce(scenarios), labels


def value_of_waiting_policy(paths: np.ndarray, request: ForecastRequest, maximum_day: int = 10) -> dict:
    """Solve the sequential transfer policy over the same robust paths.

    Each row asks: if we wait until this morning's information arrives, what
    minimum transfer still keeps at least 95% of the simulated futures above
    water? A row becomes infeasible once a prior crossing cannot be undone.
    """
    options: list[dict] = []
    horizon = paths.shape[1]
    full_horizon_amount = max(0.0, float(np.quantile(request.buffer - np.min(paths, axis=1), 1.0 - request.risk_target)))
    for day in range(1, min(maximum_day, horizon) + 1):
        # Day 1 is an immediate action before today's projected debits. Later
        # days must also survive every already-observed day before transfer.
        prior_risk = 0.0 if day == 1 else float(np.mean(np.min(paths[:, :day - 1], axis=1) < request.buffer))
        amount = full_horizon_amount
        protected = paths.copy()
        protected[:, day - 1:] += amount
        risk = float(np.mean(np.min(protected, axis=1) < request.buffer))
        feasible = amount <= request.savings_available and risk <= request.risk_target and prior_risk <= request.risk_target
        options.append({"day": day, "amount": round(amount + 0.01, 2) if amount > 0 else 0.0, "risk": round(risk, 4), "feasible": feasible})
    safe = [option for option in options if option["feasible"]]
    now = options[0] if options else None
    latest = safe[-1] if safe else None
    return {
        "riskTarget": request.risk_target,
        "actionNow": now,
        "latestSafe": latest,
        "options": options,
        "status": "wait_safe" if latest and latest["day"] > 1 else "act_now" if latest else "no_safe_wait",
    }


def receding_horizon_policy(paths: np.ndarray, request: ForecastRequest, maximum_day: int = 10, buckets: int = 8) -> dict:
    """Evaluate wait decisions after simulated information arrives.

    At each future decision day, paths are partitioned by the balance the
    person would have observed by then. Each partition gets its own posterior
    transfer calculation. This is a finite-horizon, receding-policy replay,
    not a static calendar lookup.
    """
    horizon = paths.shape[1]
    day_count = min(maximum_day, horizon)
    action_now = value_of_waiting_policy(paths, request, 1)["actionNow"]
    stages: list[dict] = []
    for day in range(1, day_count + 1):
        if day == 1:
            groups = [np.arange(paths.shape[0])]
        else:
            observed = paths[:, day - 2]
            edges = np.unique(np.quantile(observed, np.linspace(0, 1, min(buckets, len(observed)) + 1)))
            groups = [np.flatnonzero((observed >= edges[index]) & (observed <= edges[index + 1] if index == len(edges) - 2 else observed < edges[index + 1])) for index in range(len(edges) - 1)]
            groups = [group for group in groups if len(group)]
        expected_amount = 0.0
        safe_probability = 0.0
        expected_risk = 0.0
        states: list[dict] = []
        for group in groups:
            subset = paths[group]
            prior_risk = 0.0 if day == 1 else float(np.mean(np.min(subset[:, :day - 1], axis=1) < request.buffer))
            future_minimum = np.min(subset[:, day - 1:], axis=1)
            amount = max(0.0, float(np.quantile(request.buffer - future_minimum, 1.0 - request.risk_target)))
            protected = subset.copy()
            protected[:, day - 1:] += amount
            posterior_risk = float(np.mean(np.min(protected, axis=1) < request.buffer))
            feasible = prior_risk <= request.risk_target and posterior_risk <= request.risk_target and amount <= request.savings_available
            weight = len(group) / paths.shape[0]
            expected_amount += weight * amount
            expected_risk += weight * posterior_risk
            safe_probability += weight if feasible else 0.0
            states.append({"weight": round(weight, 4), "amount": round(amount + 0.01, 2) if amount else 0.0, "risk": round(posterior_risk, 4), "feasible": feasible})
        stages.append({"day": day, "expectedAmount": round(expected_amount + 0.01, 2) if expected_amount else 0.0, "expectedRisk": round(expected_risk, 4), "safeProbability": round(safe_probability, 4), "stateCount": len(states), "states": states})
    safe_stages = [stage for stage in stages if stage["safeProbability"] >= 1.0 - request.risk_target]
    latest = safe_stages[-1] if safe_stages else None
    now_amount = float(action_now["amount"]) if action_now else 0.0
    return {
        "status": "wait_safe" if latest and latest["day"] > 1 else "act_now" if latest else "no_safe_wait",
        "actionNowAmount": round(now_amount, 2),
        "latestSafeDay": latest["day"] if latest else None,
        "latestSafeExpectedAmount": latest["expectedAmount"] if latest else None,
        "informationValue": round(max(0.0, now_amount - latest["expectedAmount"]), 2) if latest else 0.0,
        "observationModel": "balance-conditioned posterior over simulated transaction and income arrivals",
        "stages": stages,
    }


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "modelVersion": MODEL_VERSION, "simulations": SIMULATION_COUNT}

@app.get("/evaluate")
def evaluate() -> dict:
    from stress_suite import run, summary
    results = run()
    return {"summary": summary(results), "scenarios": results, "modelVersion": MODEL_VERSION}


@app.post("/forecast")
def forecast(request: ForecastRequest) -> dict:
    try:
        history = daily_spend_frame(request.transactions, request.start_date)
        # A ledger can legitimately contain only detected recurring cash flow.
        # Keep the calibrated engine active with an explicit zero-variable-spend
        # history instead of silently dropping to the frontend fallback.
        if len(history) < 7:
            dates = pd.date_range(request.start_date - timedelta(days=29), request.start_date, freq="D")
            history = pd.DataFrame({"date": dates, "spend": np.zeros(len(dates)), "weekday": dates.dayofweek, "recent_7": np.zeros(len(dates)), "recent_28": np.zeros(len(dates)), "payday_distance": np.full(len(dates), 14.0)})
        featured, feature_names = feature_frame(history, request.streams, request.start_date)
        models, occurrence_model, residuals, model_family = fit_quantile_models(featured, feature_names)
        drift = spending_drift(featured)
        calibration_radius, calibration_windows, calibration_coverage, calibration_mae = rolling_calibration(featured, feature_names)
        uncertainty_multiplier = 1.5 if drift["status"] == "elevated" else 1.2 if drift["status"] == "watch" else 1.0
        low_spend, median_spend, high_spend, occurrence_probability = forecast_spending(featured, models, occurrence_model, feature_names, request.streams, request.start_date, request.horizon_days)
        deterministic_delta, events = deterministic_events(request)
        seed = int(abs(sum(transaction.amount * 100 + transaction.posted_date.toordinal() for transaction in request.transactions))) % (2**32 - 1)
        paths = simulate_paths(request.starting_balance, deterministic_delta, median_spend, residuals * uncertainty_multiplier, calibration_radius * uncertainty_multiplier, seed, request.streams, request.pending_transactions)
        paths_without_pending = simulate_paths(request.starting_balance, deterministic_delta, median_spend, residuals * uncertainty_multiplier, calibration_radius * uncertainty_multiplier, seed, request.streams, [])
        median, low, high, overdraft = risk_summary(paths, request.buffer)
        expected = request.starting_balance + np.cumsum(deterministic_delta - median_spend)
        baseline_optimizer = optimize(paths, request, deterministic_delta, median_spend)
        tail_paths, robustness_scenarios = distributionally_robust_paths(paths, median_spend, request.streams)
        robust_optimizer = optimize(tail_paths, request, deterministic_delta, median_spend)
        waiting_policy = value_of_waiting_policy(tail_paths, request)
        sequential_policy = receding_horizon_policy(tail_paths, request)
        # Prefer the least-burden plan that also clears the configured target
        # under sustained high spending. Fall back to the baseline-optimal
        # plan only when no feasible robust plan exists.
        optimizer = robust_optimizer if robust_optimizer["status"] == "solved" else baseline_optimizer
        tail_before_risk = float(np.mean(np.min(tail_paths, axis=1) < request.buffer))
        tail_after_risk = float(optimizer["recommended"]["risk"]) if optimizer["recommended"] and optimizer is robust_optimizer else None
        series = []
        for index in range(request.horizon_days):
            day = request.start_date + timedelta(days=index + 1)
            series.append({
                "date": iso(day), "dayOffset": index + 1,
                "balance": round(float(median[index]), 2), "expectedBalance": round(float(expected[index]), 2),
                "confidenceLow": round(float(low[index]), 2), "confidenceHigh": round(float(high[index]), 2),
                "overdraftProbability": round(float(overdraft[index]), 4), "isDanger": bool(median[index] < request.buffer),
                "events": events[index], "spendOccurrenceProbability": round(float(occurrence_probability[index]), 4),
            })
        # Preserve all paths for deterministic client-side counterfactuals in
        # this local hackathon build. This is intentionally not a production
        # payload shape.
        risk_samples = np.round(paths.T, 2).tolist()
        return {
            "series": series,
            "riskSamples": risk_samples,
            "risk": {
                "simulationCount": SIMULATION_COUNT,
                "historyDays": int(len(history)),
                "modelVersion": MODEL_VERSION,
                "modelFamily": model_family,
                "calibrationRadius": round(calibration_radius, 2),
                "calibrationWindows": calibration_windows,
                "calibrationHorizonDays": 7,
                "calibrationCoverage": round(calibration_coverage, 4),
                "calibrationMae": round(calibration_mae, 2),
                "drift": drift,
                "tailStressMultiplier": 1.5,
                "uncertaintyMultiplier": uncertainty_multiplier,
                "pendingTransactionCount": len(request.pending_transactions),
                "pendingBalanceGap": round((request.current_balance - request.available_balance), 2) if request.current_balance is not None and request.available_balance is not None else None,
            },
            "optimizer": optimizer,
            "robustness": {
                "tailRiskBefore": round(tail_before_risk, 4),
                "tailRiskAfter": round(tail_after_risk, 4) if tail_after_risk is not None else None,
                "stressMultiplier": 1.5,
                "scenarios": robustness_scenarios,
                "usedRobustPlan": optimizer is robust_optimizer,
                "baselineCandidateCount": baseline_optimizer["candidateCount"],
                "robustCandidateCount": robust_optimizer["candidateCount"],
            },
            "waitingPolicy": waiting_policy,
            "sequentialPolicy": sequential_policy,
            "pendingImpact": {"withoutPendingRisk": round(float(np.max(risk_summary(paths_without_pending, request.buffer)[3])), 4), "withPendingRisk": round(float(np.max(overdraft)), 4)},
        }
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Analytics forecast failed: {error}") from error
