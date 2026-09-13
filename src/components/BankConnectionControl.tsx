"use client";

import { useEffect, useRef, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { Landmark, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";

type Status = "idle" | "creating-link" | "connecting" | "syncing" | "connected" | "error";
type ConnectionState = { connected: boolean; lastSyncedAt?: string | null; webhookConfigured: boolean };

function syncTimeLabel(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

/** Sandbox is intentionally one click; production endpoints require real auth. */
export default function BankConnectionControl() {
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  const openedLinkToken = useRef<string | null>(null);

  async function loadConnection() {
    try {
      const response = await fetch("/api/connection", { cache: "no-store" });
      const data: ConnectionState = await response.json();
      setConnection(data);
      if (data.connected) setStatus("connected");
    } catch {
      // The connection control remains usable even if this optional status check fails.
    }
  }

  useEffect(() => {
    fetch("/api/connection", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: ConnectionState) => {
        setConnection(data);
        if (data.connected) setStatus("connected");
      })
      .catch(() => undefined);
  }, []);

  async function createLinkToken() {
    setStatus("creating-link");
    setMessage(null);
    try {
      const response = await fetch("/api/plaid/link-token", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not start bank connection");
      setLinkToken(payload.linkToken);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Could not start bank connection");
    }
  }

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: async (publicToken) => {
      setStatus("connecting");
      try {
        const exchange = await fetch("/api/plaid/exchange-token", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ publicToken }),
        });
        const exchangePayload = await exchange.json();
        if (!exchange.ok) throw new Error(exchangePayload.error ?? "Could not save bank connection");
        setStatus("syncing");
        const sync = await fetch("/api/plaid/sync", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId: exchangePayload.itemId }),
        });
        const syncPayload = await sync.json();
        if (!sync.ok) throw new Error(syncPayload.error ?? "Bank connected, but first sync failed");
        setStatus("connected");
        setMessage(`${syncPayload.added ?? 0} Sandbox transactions safely synced.`);
        await loadConnection();
        window.dispatchEvent(new Event("overcast-bank-connected"));
      } catch (error) {
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "Could not finish bank connection");
      }
    },
    onExit: (error) => {
      if (error) {
        setStatus("error");
        setMessage(error.display_message ?? error.error_message ?? "Bank connection was not completed");
      } else if (status === "creating-link") setStatus("idle");
    },
  });

  useEffect(() => {
    if (linkToken && ready && openedLinkToken.current !== linkToken) {
      openedLinkToken.current = linkToken;
      open();
    }
  }, [linkToken, open, ready]);

  async function refreshBankData() {
    setStatus("syncing");
    setMessage(null);
    try {
      const response = await fetch("/api/plaid/sync", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not refresh Sandbox data");
      await loadConnection();
      setStatus("connected");
      setMessage("Forecast refreshed from Plaid Sandbox.");
      window.dispatchEvent(new Event("overcast-bank-connected"));
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Could not refresh Sandbox data");
    }
  }

  const busy = ["creating-link", "connecting", "syncing"].includes(status);
  const syncedLabel = syncTimeLabel(connection?.lastSyncedAt);
  return (
    <div className="radar-connection-control relative flex items-center gap-1.5 sm:gap-2">
      <button type="button" onClick={createLinkToken} disabled={busy} className="radar-connect-button">
        {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : status === "connected" ? <ShieldCheck className="h-3.5 w-3.5" /> : <Landmark className="h-3.5 w-3.5" />}
        {status === "connected" ? "Bank connected" : busy ? "Connecting…" : "Connect Sandbox bank"}
      </button>
      {connection?.connected && (
        <>
          <button type="button" onClick={refreshBankData} disabled={busy} className="radar-sync-button" title="Refresh transactions and rebuild the forecast" aria-label="Refresh Sandbox bank data">
            <RefreshCw className={`h-3.5 w-3.5 ${status === "syncing" ? "animate-spin" : ""}`} />
          </button>
          <span className="radar-sync-status" title={connection.webhookConfigured ? "Plaid webhooks will refresh this forecast automatically when activity changes." : "Automatic Plaid webhooks are not configured. Use refresh during the demo."}>
            <i className={connection.webhookConfigured ? "is-live" : ""} />
            {connection.webhookConfigured ? "Live updates" : syncedLabel ? `Synced ${syncedLabel}` : "Synced"}
          </span>
        </>
      )}
      {message && <p className={`radar-connection-message ${status === "error" ? "is-error" : ""}`} role={status === "error" ? "alert" : "status"}>{message}</p>}
    </div>
  );
}
