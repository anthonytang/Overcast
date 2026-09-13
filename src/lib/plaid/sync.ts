import "server-only";

import { createPlaidClient } from "@/lib/plaid/client";
import { decryptAccessToken } from "@/lib/security/token-crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type BankItem = { id: string; user_id: string; plaid_item_id: string; access_token_encrypted: string; sync_cursor: string | null };

const cadenceDays: Record<string, number> = {
  WEEKLY: 7, BIWEEKLY: 14, SEMI_MONTHLY: 15, MONTHLY: 30, ANNUALLY: 365,
};

/**
 * Pulls added, modified, and removed transactions using Plaid's cursor model.
 * It is safe to call repeatedly: upserts make it idempotent and the cursor is
 * only advanced after all pages have been written successfully.
 */
export async function syncPlaidItem(item: BankItem) {
  const db = createSupabaseAdminClient();
  const plaid = createPlaidClient();
  const accessToken = decryptAccessToken(item.access_token_encrypted);
  const accountsResponse = await plaid.accountsGet({ access_token: accessToken });
  const accounts = accountsResponse.data.accounts;

  const { error: accountsError } = await db.from("bank_accounts").upsert(
    accounts.map((account) => ({
      user_id: item.user_id,
      bank_item_id: item.id,
      plaid_account_id: account.account_id,
      name: account.name,
      official_name: account.official_name,
      mask: account.mask,
      account_type: account.type,
      current_balance: account.balances.current,
      available_balance: account.balances.available,
      balance_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })),
    { onConflict: "plaid_account_id" }
  );
  if (accountsError) throw new Error(`Could not save accounts: ${accountsError.message}`);

  const { data: storedAccounts, error: storedAccountsError } = await db
    .from("bank_accounts")
    .select("id,plaid_account_id")
    .eq("bank_item_id", item.id);
  if (storedAccountsError) throw new Error(`Could not read accounts: ${storedAccountsError.message}`);
  const accountIds = new Map((storedAccounts ?? []).map((account) => [account.plaid_account_id, account.id]));

  let cursor = item.sync_cursor ?? undefined;
  let pages = 0;
  let added = 0;
  let modified = 0;
  let removed = 0;
  let hasMore = true;

  while (hasMore) {
    const response = await plaid.transactionsSync({ access_token: accessToken, cursor });
    const payload = response.data;
    const writeTransactions = async (transactions: typeof payload.added) => {
      const rows = transactions
        .map((transaction) => {
          const accountId = accountIds.get(transaction.account_id);
          if (!accountId) return null;
          return {
            user_id: item.user_id,
            account_id: accountId,
            plaid_transaction_id: transaction.transaction_id,
            posted_date: transaction.date,
            authorized_date: transaction.authorized_date,
            amount: transaction.amount,
            merchant_name: transaction.merchant_name,
            description: transaction.name,
            primary_category: transaction.personal_finance_category?.primary ?? null,
            detailed_category: transaction.personal_finance_category?.detailed ?? null,
            pending: transaction.pending,
            is_removed: false,
            raw_payload: transaction,
            updated_at: new Date().toISOString(),
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null);
      if (rows.length === 0) return;
      const { error } = await db.from("transactions").upsert(rows, { onConflict: "plaid_transaction_id" });
      if (error) throw new Error(`Could not write transactions: ${error.message}`);
    };

    await writeTransactions(payload.added);
    await writeTransactions(payload.modified);
    for (const transaction of payload.removed) {
      const { error } = await db.from("transactions")
        .update({ is_removed: true, updated_at: new Date().toISOString() })
        .eq("plaid_transaction_id", transaction.transaction_id)
        .eq("user_id", item.user_id);
      if (error) throw new Error(`Could not mark removed transaction: ${error.message}`);
    }

    added += payload.added.length;
    modified += payload.modified.length;
    removed += payload.removed.length;
    pages += 1;
    cursor = payload.next_cursor;
    hasMore = payload.has_more;
  }

  const { error: cursorError } = await db.from("bank_items")
    .update({ sync_cursor: cursor ?? null, updated_at: new Date().toISOString() })
    .eq("id", item.id);
  if (cursorError) throw new Error(`Could not save sync cursor: ${cursorError.message}`);

  // Recurring streams can take longer than the first transaction pull to be
  // available. A not-ready response must not make an otherwise good bank
  // connection fail; the next manual/webhook sync will try again.
  let recurring = 0;
  try {
    const recurringResponse = await plaid.transactionsRecurringGet({ access_token: accessToken });
    const streams = [
      ...recurringResponse.data.inflow_streams.map((stream) => ({ stream, isIncome: true })),
      ...recurringResponse.data.outflow_streams.map((stream) => ({ stream, isIncome: false })),
    ];
    const rows = streams
      .map(({ stream, isIncome }) => {
        const accountId = accountIds.get(stream.account_id);
        const cadence = cadenceDays[stream.frequency];
        if (!accountId || !cadence) return null;
        return {
          user_id: item.user_id,
          account_id: accountId,
          plaid_stream_id: stream.stream_id,
          name: stream.merchant_name ?? stream.description,
          amount: stream.average_amount.amount,
          cadence_days: cadence,
          next_expected_date: stream.predicted_next_date ?? null,
          is_income: isIncome,
          source: "plaid",
          active: stream.is_active,
          updated_at: new Date().toISOString(),
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
    if (rows.length > 0) {
      const { error } = await db.from("recurring_streams").upsert(rows, { onConflict: "plaid_stream_id" });
      if (error) throw new Error(`Could not save recurring streams: ${error.message}`);
      recurring = rows.length;
    }
  } catch {
    // The forecast falls back to historical spending velocity until Plaid has
    // completed recurring-stream analysis for this Item.
  }

  return { pages, added, modified, removed, recurring };
}
