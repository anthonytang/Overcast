import "server-only";

import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { getServerEnv } from "@/lib/server-env";

/** Sandbox by default. Production requires an explicit deployment setting. */
export function createPlaidClient() {
  const env = getServerEnv();
  const environment = process.env.PLAID_ENV === "production"
    ? PlaidEnvironments.production
    : PlaidEnvironments.sandbox;

  return new PlaidApi(
    new Configuration({
      basePath: environment,
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": env.plaidClientId,
          "PLAID-SECRET": env.plaidSecret,
        },
      },
    })
  );
}
