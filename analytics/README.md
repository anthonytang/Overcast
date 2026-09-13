# Overcast analytics service

This is the local decision engine for the hackathon demo. It learns a
transaction-derived variable-spending distribution, calibrates its uncertainty
against rolling historical windows, simulates 10,000 possible balance paths,
and finds the least-burden simulated intervention that reaches the risk target.

## Run locally

```bash
cd app/analytics
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Set `ANALYTICS_URL=http://127.0.0.1:8000` in `app/.env.local`, then run the
Next.js app normally from the repository root with `npm run dev`.

The app preserves a deterministic local fallback when this service is not
running. The forecast transparency panel states which engine produced the
active forecast, so a fallback cannot be mistaken for the calibrated model.

## What is modeled

- Known recurring income and bills are scheduled deterministically.
- Variable spending is represented by a gradient-boosted conditional quantile
  model using weekday, category mix, recent spending velocity, and distance to
  the next detected payday.
- Rolling historical residuals provide conformal uncertainty calibration.
- The optimizer tests transfers, bill deferrals, and spending reductions over
  the exact same simulated future paths.

Sandbox data is synthetic. Metrics describe performance on the connected
Sandbox history only and are not claims about real consumer accuracy.
