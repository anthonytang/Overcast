import { NextResponse } from "next/server";
import { z } from "zod";
import { createPlaidClient } from "@/lib/plaid/client";
import { encryptAccessToken } from "@/lib/security/token-crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveBankUser } from "@/lib/supabase/resolve-bank-user";

export const runtime = "nodejs";

const bodySchema = z.object({ publicToken: z.string().min(1) });

/** Exchanges the browser's one-time public token and persists only its encrypted access token. */
export async function POST(request: Request) {
  try {
    const user = await resolveBankUser(request);
    const { publicToken } = bodySchema.parse(await request.json());
    const exchange = await createPlaidClient().itemPublicTokenExchange({ public_token: publicToken });
    const item = exchange.data;
    const db = createSupabaseAdminClient();
    const { error } = await db.from("bank_items").upsert({
      user_id: user.id,
      plaid_item_id: item.item_id,
      access_token_encrypted: encryptAccessToken(item.access_token),
      status: "active",
      updated_at: new Date().toISOString(),
    }, { onConflict: "plaid_item_id" });
    if (error) throw new Error(`Could not save connected bank: ${error.message}`);
    const response = NextResponse.json({ itemId: item.item_id });
    response.cookies.set("overcast_sandbox_item", item.item_id, {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24,
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not exchange Plaid token";
    const status = message === "Authentication required" || message === "Invalid session" ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
