"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import logoImg from "../../public/logo.png";
import type { ForecastResult } from "@/lib/forecast";
import OvercastWorkspace, { AppHeader, type View } from "@/components/OvercastWorkspace";
import BankConnectionControl from "@/components/BankConnectionControl";
import LandingPage from "@/components/LandingPage";

function viewFromHash(): View {
  if (typeof window === "undefined") return "account";
  const match = window.location.hash.match(/view-(position|risk|test|plan|spend|account)/);
  return (match?.[1] as View | undefined) ?? "account";
}

export default function Home() {
  const [authUser, setAuthUser] = useState<{ email: string } | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [data, setData] = useState<ForecastResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unconnected, setUnconnected] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  // Keep the first client render identical to the server render. The hash is
  // browser-only state and is deliberately applied in the effect below.
  const [activeView, setActiveView] = useState<View>("account");
  const [routeResolved, setRouteResolved] = useState(false);

  // Check auth session
  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => res.json())
      .then((payload) => {
        if (payload?.user) {
          setAuthUser(payload.user);
        } else {
          setAuthUser(null);
        }
      })
      .catch(() => setAuthUser(null))
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    if (!authUser) return;

    const loadForecast = () => {
      setError(null);
      fetch("/api/forecast")
        .then((res) => {
          if (!res.ok) throw new Error(`API returned ${res.status}`);
          return res.json();
        })
        .then((payload) => {
          if (payload.status === "unconnected") {
            setUnconnected(true);
            setData(null);
          } else {
            setUnconnected(false);
            setData(payload);
          }
        })
        .catch((err) => setError(String(err)));
    };
    loadForecast();
    window.addEventListener("overcast-bank-connected", loadForecast);
    return () => window.removeEventListener("overcast-bank-connected", loadForecast);
  }, [authUser, retryCount]);

  useEffect(() => {
    const syncActiveView = () => {
      setActiveView(viewFromHash());
      setRouteResolved(true);
    };
    // A hashchange event is only dispatched after a hash changes. On a hard
    // reload it has already been set, so synchronise once on mount as well.
    // This keeps the shared header aligned with the workspace's initial view.
    syncActiveView();
    window.addEventListener("hashchange", syncActiveView);
    window.addEventListener("popstate", syncActiveView);
    return () => {
      window.removeEventListener("hashchange", syncActiveView);
      window.removeEventListener("popstate", syncActiveView);
    };
  }, []);

  function navigate(view: View) {
    setActiveView(view);
    setRouteResolved(true);
    window.location.hash = `view-${view}`;
  }

  async function handleSignOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Ignore
    }
    setAuthUser(null);
    setData(null);
  }

  // If still verifying initial auth state
  if (!authChecked) {
    return (
      <div className="landing-shell" style={{ display: "grid", placeItems: "center" }}>
        <div className="oc-loading"><span /> Verifying session...</div>
      </div>
    );
  }

  // If unauthenticated, show the Landing Page
  if (!authUser) {
    return (
      <LandingPage
        onLoginSuccess={(user) => {
          setAuthUser(user);
          setRetryCount((count) => count + 1);
        }}
      />
    );
  }

  const header = (
    <AppHeader
      activeView={activeView}
      routeResolved={routeResolved}
      onNavigate={data ? navigate : undefined}
      accountName={data?.accountName}
      lastSyncedAt={data?.transparency?.lastSyncedAt}
      user={authUser}
      onSignOut={handleSignOut}
    />
  );

  if (error) {
    return (
      <div className="overcast-shell">
        {header}
        <main className="oc-bootstrap-state">
          <section className="oc-empty-state" role="alert" aria-live="assertive">
            <p>FORECAST UNAVAILABLE</p>
            <h1>We could not load your cash-flow outlook.</h1>
            <span>{error}</span>
            <button className="button button--primary" onClick={() => setRetryCount((count) => count + 1)}>
              Try again
            </button>
          </section>
        </main>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="overcast-shell">
        {header}
        <main className="oc-bootstrap-state">
          {unconnected ? (
            <section className="oc-empty-state">
              <Image src={logoImg} alt="Overcast logo" width={60} height={60} style={{ marginBottom: 16, mixBlendMode: "multiply", borderRadius: 8 }} />
              <p>NO FORECAST YET</p>
              <h1>Your cash flow starts with real data.</h1>
              <span>Connect a Plaid Sandbox bank to see your balance, upcoming bills, and overdraft risk. Overcast never fills this screen with fake financial data.</span>
              <BankConnectionControl />
            </section>
          ) : (
            <div className="oc-loading"><span /> Loading your forecast</div>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="overcast-shell">
      {header}
      <OvercastWorkspace data={data} activeView={activeView} onNavigate={navigate} />
    </div>
  );
}

