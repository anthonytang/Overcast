import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { runLiveForecast } from "@/lib/live-forecast";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveBankUser } from "@/lib/supabase/resolve-bank-user";

export async function GET(request: NextRequest) {
  try {
    const plaidItemId = request.cookies.get("overcast_sandbox_item")?.value;
    if (!plaidItemId) return NextResponse.json({ runs: [] });
    const user = await resolveBankUser(request);
    const db = createSupabaseAdminClient();
    const { data: item } = await db.from("bank_items").select("id").eq("user_id", user.id).eq("plaid_item_id", plaidItemId).maybeSingle();
    if (!item) return NextResponse.json({ runs: [] });
    const { data: accounts } = await db.from("bank_accounts").select("id,account_type").eq("bank_item_id", item.id);
    const account = accounts?.find((candidate) => candidate.account_type === "depository") ?? accounts?.[0];
    if (!account) return NextResponse.json({ runs: [] });
    const { data, error } = await db.from("analytics_runs")
      .select("id,generated_at,model_version,model_family,simulation_count,calibration_windows,risk_target,result")
      .eq("account_id", account.id).order("generated_at", { ascending: false }).limit(8);
    if (error) throw new Error(error.message);
    return NextResponse.json({ runs: data ?? [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load decision history" }, { status: 500 });
  }
}

/** Explicitly records a reproducible analytics artifact. Forecast GET requests
 * remain side-effect free, so simply viewing the dashboard never fills the
 * database with duplicate multi-path payloads. */
export async function POST(request: NextRequest) {
  try {
    const plaidItemId = request.cookies.get("overcast_sandbox_item")?.value;
    if (!plaidItemId) return NextResponse.json({ error: "No connected Sandbox bank" }, { status: 404 });
    const user = await resolveBankUser(request);
    const db = createSupabaseAdminClient();
    const { data: item } = await db.from("bank_items").select("id").eq("user_id", user.id).eq("plaid_item_id", plaidItemId).maybeSingle();
    if (!item) return NextResponse.json({ error: "Connected bank was not found" }, { status: 404 });
    const { data: accounts } = await db.from("bank_accounts").select("id,account_type").eq("bank_item_id", item.id);
    const account = accounts?.find((candidate) => candidate.account_type === "depository") ?? accounts?.[0];
    if (!account) return NextResponse.json({ error: "No account is available" }, { status: 404 });
    const result = await runLiveForecast(user.id, plaidItemId);
    if (!result?.risk || result.transparency?.analyticsEngine !== "calibrated") {
      return NextResponse.json({ error: "Start the calibrated analytics service before recording a run" }, { status: 409 });
    }
    const storableResult = { ...result };
    delete storableResult.riskSamples;
    const inputFingerprint = createHash("sha256")
      .update(JSON.stringify({
        syncedAt: result.transparency?.lastSyncedAt,
        transactionCount: result.transparency?.transactionCount,
        streams: result.streams,
        modelVersion: result.risk.modelVersion,
      }))
      .digest("hex");
    const { error } = await db.from("analytics_runs").insert({
      user_id: user.id,
      account_id: account.id,
      model_version: result.risk.modelVersion,
      model_family: result.risk.modelFamily ?? "unknown",
      input_fingerprint: inputFingerprint,
      simulation_count: result.risk.simulationCount,
      calibration_windows: result.risk.calibrationWindows ?? 0,
      calibration_radius: result.risk.calibrationRadius ?? 0,
      risk_target: result.decisionPlan?.riskTarget ?? 0.05,
      result: storableResult,
    });
    if (error) throw new Error(error.message);
    return NextResponse.json({ recordedAt: new Date().toISOString(), modelVersion: result.risk.modelVersion });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not record analytics run" }, { status: 500 });
  }
}
