"""Deterministic adversarial evaluation for the Overcast decision engine."""
from datetime import date, timedelta
from main import ForecastRequest, Stream, Transaction, forecast

def _history(anchor, days): return [Transaction(amount=18 + (i % 6) * 5, posted_date=anchor-timedelta(days=i), description="Market", primary_category="FOOD_AND_DRINK") for i in range(1, days + 1)]
def run():
    anchor = date.today(); results=[]
    personas=[("paycheck_delayed",120,7,7,120,3000),("rent_arrives_early",300,2,7,120,3000),("variable_spending_spike",90,4,7,120,3000),("missing_recurring_detection",320,3,7,120,3000),("low_history",260,3,7,12,3000),("high_history",260,3,7,240,3000),("savings_unavailable",90,3,7,120,0),("multiple_bills_same_day",130,3,3,120,3000)]
    for name,balance,rent_day,pay_day,history_days,savings in personas:
        streams=[Stream(name="PAYROLL",amount=1400,cadence_days=14,is_income=True,first_day=pay_day),Stream(name="RENT",amount=1120,cadence_days=30,is_income=False,first_day=rent_day)]
        if name=="multiple_bills_same_day": streams.append(Stream(name="ELECTRIC",amount=170,cadence_days=30,is_income=False,first_day=rent_day))
        if name=="missing_recurring_detection": streams=[]
        output=forecast(ForecastRequest(starting_balance=balance,start_date=anchor,savings_available=savings,streams=streams,transactions=_history(anchor,history_days)))
        plan=output["optimizer"]
        predicted_risk = max(day["overdraftProbability"] for day in output["series"])
        # The deterministic median projection is the known outcome for this
        # synthetic persona. It gives the stress lab a reproducible label
        # without pretending its generated scenarios are real account data.
        actual_overdraft = min(day["expectedBalance"] for day in output["series"]) < 0
        robust = output.get("robustness", {})
        results.append({"persona":name,"forecast_error":output["risk"]["calibrationMae"],"interval_coverage":output["risk"]["calibrationCoverage"],"predicted_risk":predicted_risk,"actual_overdraft":actual_overdraft,"predicted_overdraft":predicted_risk>=0.5,"optimizer_success":plan["status"]=="solved","post_fix_target_met":bool(plan["recommended"] and plan["recommended"]["risk"]<=plan["riskTarget"]),"robust_plan_success":bool(robust.get("usedRobustPlan") and robust.get("tailRiskAfter") is not None and robust["tailRiskAfter"] <= plan["riskTarget"])})
    return results
def summary(results):
    n = len(results)
    true_positive = sum(r["predicted_overdraft"] and r["actual_overdraft"] for r in results)
    false_positive = sum(r["predicted_overdraft"] and not r["actual_overdraft"] for r in results)
    false_negative = sum(not r["predicted_overdraft"] and r["actual_overdraft"] for r in results)
    precision = true_positive / (true_positive + false_positive) if true_positive + false_positive else 0.0
    recall = true_positive / (true_positive + false_negative) if true_positive + false_negative else 0.0
    return {"scenarioCount":n,"meanForecastError":round(sum(r["forecast_error"] for r in results)/n,2),"meanIntervalCoverage":round(sum(r["interval_coverage"] for r in results)/n,4),"optimizerSuccessRate":round(sum(r["optimizer_success"] for r in results)/n,4),"postFixTargetRate":round(sum(r["post_fix_target_met"] for r in results)/n,4),"robustPlanSuccessRate":round(sum(r["robust_plan_success"] for r in results)/n,4),"overdraftPrecision":round(precision,4),"overdraftRecall":round(recall,4)}
if __name__ == "__main__": print(summary(run()))
