import { CountryCode, Products } from "plaid";
import { NextResponse } from "next/server";
import { createPlaidClient } from "@/lib/plaid/client";
import { resolveBankUser } from "@/lib/supabase/resolve-bank-user";

export const runtime = "nodejs";

/** Creates a short-lived, single-use Link token for the signed-in user. */
export async function POST(request: Request) {
  try {
    const user = await resolveBankUser(request);
    const webhook = process.env.PLAID_WEBHOOK_URL;
    const response = await createPlaidClient().linkTokenCreate({
      user: { client_user_id: user.id },
      client_name: "Overcast",
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: "en",
      transactions: { days_requested: 180 },
      ...(webhook ? { webhook } : {}),
    });
    return NextResponse.json({
      linkToken: response.data.link_token,
      expiration: response.data.expiration,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create Plaid Link token";
    return NextResponse.json({ error: message }, { status: message === "Authentication required" || message === "Invalid session" ? 401 : 500 });
  }
}
