"use client";

import { useState } from "react";
import Image from "next/image";
import logoImg from "../../public/logo.png";
import {
  Activity, AlertTriangle, ArrowRight, Check,
  CircleDollarSign, Clock, Cpu, FileText, Layers, Lock,
  LoaderCircle, Shield, SlidersHorizontal, TrendingDown,
  User,
} from "lucide-react";

interface LandingPageProps {
  onLoginSuccess: (user: { email: string }) => void;
}

export default function LandingPage({ onLoginSuccess }: LandingPageProps) {
  const [showModal, setShowModal] = useState(false);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("test@gmail.com");
  const [password, setPassword] = useState("test123");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogin(customEmail?: string, customPassword?: string) {
    const submitEmail = (customEmail ?? email).trim();
    const submitPassword = customPassword ?? password;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: submitEmail, password: submitPassword }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Authentication failed");
      }

      onLoginSuccess(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in");
    } finally {
      setLoading(false);
    }
  }

  function openAuth(mode: "signin" | "signup") {
    setAuthMode(mode);
    setError(null);
    setShowModal(true);
  }

  return (
    <div className="landing-shell">
      {/* Top Navbar */}
      <header className="app-header">
        <div className="app-header__inner">
          <button
            type="button"
            className="brand"
            aria-label="Overcast home"
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          >
            <span className="brand__mark">
              <Image
                src={logoImg}
                alt="Overcast logo"
                width={34}
                height={34}
                className="brand__img"
                priority
              />
            </span>
            <span>
              <strong>Overcast</strong>
              <small>Cash flow forecast</small>
            </span>
          </button>

          <div />

          <div className="landing-nav__actions">
            <button
              type="button"
              className="button button--ghost"
              onClick={() => openAuth("signin")}
            >
              Sign in
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => openAuth("signup")}
            >
              Sign up
            </button>
          </div>
        </div>
      </header>

      {/* Main Single-Screen Content */}
      <main className="landing-main">
        <div className="landing-grid">
          {/* Left Column: Hero & Overdraft Prevention Pillars */}
          <div className="landing-col-left">
            <h1 className="landing-hero__title">
              See the overdraft <br />
              before it happens.
            </h1>

            <p className="landing-hero__subtitle">
              Predictive 30-day cash flow intelligence. Overcast monitors your checking account, spots bill timing collisions before payday, and helps you fix shortfalls before fees hit.
            </p>

            <div className="landing-hero__cta">
              <button
                type="button"
                className="button button--primary landing-cta-btn"
                onClick={() => openAuth("signup")}
              >
                <span>Get started</span>
                <ArrowRight size={15} />
              </button>
              <button
                type="button"
                className="button button--secondary landing-secondary-btn"
                onClick={() => openAuth("signin")}
              >
                <span>Sign in</span>
              </button>
            </div>

            {/* Core 4 App Features Matching Main Tabs */}
            <div className="landing-mini-features">
              <div className="landing-mini-card">
                <div className="landing-mini-card__icon text-risk">
                  <TrendingDown size={16} />
                </div>
                <div>
                  <strong>30-Day Forecast</strong>
                  <p>Maps daily income and bills day by day to spot dips before your next paycheck</p>
                </div>
              </div>

              <div className="landing-mini-card">
                <div className="landing-mini-card__icon text-safe">
                  <Activity size={16} />
                </div>
                <div>
                  <strong>Stress Test Simulator</strong>
                  <p>Runs 1,000 real-world spending simulations to test volatility and calculate peak risk</p>
                </div>
              </div>

              <div className="landing-mini-card">
                <div className="landing-mini-card__icon text-safe">
                  <SlidersHorizontal size={16} />
                </div>
                <div>
                  <strong>Quick Fix Finder</strong>
                  <p>Evaluates bill shifts, savings transfers, and spending adjustments to protect your balance</p>
                </div>
              </div>

              <div className="landing-mini-card">
                <div className="landing-mini-card__icon text-safe">
                  <CircleDollarSign size={16} />
                </div>
                <div>
                  <strong>Safe Spending Budget</strong>
                  <p>Sets aside money for bills and safety buffers to calculate your weekly allowance</p>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Live Overdraft Detection Terminal Preview */}
          <div className="landing-col-right">
            <div className="landing-preview-card">
              {/* Terminal Header */}
              <div className="landing-preview-card__header">
                <div className="landing-preview-card__tags">
                  <span className="landing-preview-tag">
                    <Activity size={12} className="text-safe" />
                    <span>Checking (...4021)</span>
                  </span>
                  <span className="landing-preview-tag">
                    <Cpu size={12} />
                    <span>1,000 Simulations</span>
                  </span>
                </div>
              </div>

              {/* Top Key Metrics Strip */}
              <div className="landing-preview-grid">
                <div className="landing-preview-stat">
                  <span className="landing-preview-stat__label">Current Balance</span>
                  <strong className="landing-preview-stat__val">$1,850.00</strong>
                  <small className="landing-preview-stat__sub">Live checking sync</small>
                </div>
                <div className="landing-preview-stat" style={{ borderColor: "rgba(168, 66, 66, 0.3)", background: "var(--risk-soft)" }}>
                  <span className="landing-preview-stat__label" style={{ color: "var(--risk)" }}>Projected Low</span>
                  <strong className="landing-preview-stat__val" style={{ color: "var(--risk)" }}>-$120.00</strong>
                  <small className="landing-preview-stat__sub" style={{ color: "var(--risk)" }}>Overdraft on Day 14</small>
                </div>
                <div className="landing-preview-stat">
                  <span className="landing-preview-stat__label">Overdraft Risk</span>
                  <strong className="landing-preview-stat__val" style={{ color: "var(--risk)" }}>87%</strong>
                  <small className="landing-preview-stat__sub">High collision risk</small>
                </div>
                <div className="landing-preview-stat">
                  <span className="landing-preview-stat__label">Next Paycheck</span>
                  <strong className="landing-preview-stat__val text-safe">+$2,450.00</strong>
                  <small className="landing-preview-stat__sub">Arrives Day 18 (4d late)</small>
                </div>
              </div>

              {/* Clean Overdraft Trajectory Chart */}
              <div className="landing-preview-chart">
                <div className="landing-chart-visual">
                  <svg viewBox="0 0 500 130" className="landing-svg-chart" preserveAspectRatio="none">
                    <defs>
                      {/* Red Danger Gradient under $0 floor */}
                      <linearGradient id="overdraftZoneGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#a84242" stopOpacity="0.25" />
                        <stop offset="100%" stopColor="#a84242" stopOpacity="0.08" />
                      </linearGradient>
                      {/* Safe Green Gradient above $0 floor */}
                      <linearGradient id="safeWaterlineGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#176b55" stopOpacity="0.16" />
                        <stop offset="100%" stopColor="#176b55" stopOpacity="0.00" />
                      </linearGradient>
                    </defs>

                    {/* Y-Axis Grid Lines */}
                    <line x1="16" y1="18" x2="484" y2="18" stroke="#e5e2d8" strokeWidth="0.8" strokeDasharray="2 3" />
                    <line x1="16" y1="50" x2="484" y2="50" stroke="#e5e2d8" strokeWidth="0.8" strokeDasharray="2 3" />
                    
                    {/* $500 Target Cushion Line */}
                    <line x1="16" y1="68" x2="484" y2="68" stroke="#996619" strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />

                    {/* $0 Overdraft Baseline (Solid, clearly highlighted) */}
                    <line x1="16" y1="88" x2="484" y2="88" stroke="#a84242" strokeWidth="1.2" opacity="0.7" />

                    {/* Overdraft Danger Fill (<$0) */}
                    <path
                      d="M 195,88 C 215,92 230,110 245,110 C 260,110 275,94 290,88 Z"
                      fill="url(#overdraftZoneGrad)"
                    />

                    {/* Main Waterline Curve */}
                    {/* Safe segment (Day 1 to 11) */}
                    <path
                      d="M 16,24 C 60,28 95,54 140,56 C 160,58 175,72 195,88"
                      fill="none"
                      stroke="#176b55"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />

                    {/* Overdraft Danger segment (Day 11 to 16, dipping below $0 to -$120) */}
                    <path
                      d="M 195,88 C 215,104 230,110 245,110 C 260,110 275,100 290,88"
                      fill="none"
                      stroke="#a84242"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />

                    {/* Rebound segment (Day 16 to 30, Payday deposit) */}
                    <path
                      d="M 290,88 C 305,74 315,22 345,22 C 385,22 430,40 484,42"
                      fill="none"
                      stroke="#176b55"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />

                    {/* Overdraft Breach Callout Marker */}
                    <circle cx="245" cy="110" r="4.5" fill="#a84242" stroke="#fff" strokeWidth="1.5" />
                    <rect x="216" y="113" width="58" height="14" rx="3" fill="#a84242" />
                    <text x="245" y="123.5" fontSize="7.5" fill="#fff" fontWeight="800" textAnchor="middle">Overdraft</text>
                  </svg>
                </div>
              </div>

              {/* Security Strip */}
              <div className="landing-preview-card__footer">
                <div className="landing-trust-item">
                  <Shield size={12} className="text-safe" />
                  <span>256-Bit Plaid Protocol</span>
                </div>
                <div className="landing-trust-item">
                  <Lock size={12} className="text-safe" />
                  <span>Read-Only Account Sync</span>
                </div>
                <div className="landing-trust-item">
                  <Check size={12} className="text-safe" />
                  <span>Zero Overdraft Fees</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Auth Modal */}
      {showModal && (
        <div className="landing-modal-overlay" onClick={() => setShowModal(false)}>
          <div
            className="landing-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="landing-modal__head">
              <div className="landing-modal__brand">
                <div className="brand__mark">
                  <Image src={logoImg} alt="Logo" width={24} height={24} />
                </div>
                <h2 id="auth-title">
                  {authMode === "signup" ? "Create your account" : "Sign in to Overcast"}
                </h2>
              </div>
              <p>
                {authMode === "signup"
                  ? "Get started with predictive overdraft forecasting."
                  : "Enter your credentials to access your financial forecast."}
              </p>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleLogin();
              }}
              className="landing-modal__form"
            >
              <div className="form-group">
                <label htmlFor="auth-email">Email Address</label>
                <div className="input-with-icon">
                  <User size={14} />
                  <input
                    id="auth-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="test@gmail.com"
                    required
                  />
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="auth-password">Password</label>
                <div className="input-with-icon">
                  <Lock size={14} />
                  <input
                    id="auth-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                  />
                </div>
              </div>

              {error && (
                <div className="error-copy" role="alert">
                  {error}
                </div>
              )}

              <div className="landing-modal__actions">
                <button
                  type="submit"
                  className="button button--primary"
                  style={{ width: "100%", justifyContent: "center", height: 42 }}
                  disabled={loading}
                >
                  {loading ? <LoaderCircle size={16} className="spin" /> : <ArrowRight size={16} />}
                  <span>{loading ? "Authenticating..." : authMode === "signup" ? "Create Account & Sign In" : "Sign in"}</span>
                </button>

                <div style={{ textAlign: "center", marginTop: 4 }}>
                  {authMode === "signup" ? (
                    <button
                      type="button"
                      className="button button--ghost"
                      style={{ fontSize: "0.76rem", padding: "4px 8px" }}
                      onClick={() => setAuthMode("signin")}
                    >
                      Already have an account? Sign in
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="button button--ghost"
                      style={{ fontSize: "0.76rem", padding: "4px 8px" }}
                      onClick={() => setAuthMode("signup")}
                    >
                      Need an account? Sign up
                    </button>
                  )}
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
