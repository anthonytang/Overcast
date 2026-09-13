import { NextResponse } from "next/server";

/** Proxies the local evaluator so the browser never needs direct analytics
 * service access. It is intentionally read-only and demo-safe. */
export async function GET() {
  const base = process.env.ANALYTICS_URL?.replace(/\/$/, "");
  if (!base) return NextResponse.json({ error: "Analytics service is unavailable" }, { status: 503 });
  try {
    const response = await fetch(`${base}/evaluate`, { cache: "no-store" });
    if (!response.ok) throw new Error();
    return NextResponse.json(await response.json());
  } catch { return NextResponse.json({ error: "Evaluation service is unavailable" }, { status: 503 }); }
}
