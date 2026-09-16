"use client";

import { useSession, signIn } from "next-auth/react";
import LegalFooter from "../components/LegalFooter";
import { useState, useEffect } from "react";

export default function UpgradePage() {
  const { data: session, status } = useSession();
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [price, setPrice] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const canceled = new URLSearchParams(window.location.search).get("canceled") === "1";
    const canceledTimer = canceled
      ? window.setTimeout(() => setMessage("Checkout canceled — you were not charged."), 0)
      : null;
    void fetch("/api/stripe/price")
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((data: { unitAmount?: number; currency?: string }) => {
        if (typeof data.unitAmount !== "number" || !data.currency) return;
        setPrice(new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: data.currency.toUpperCase(),
        }).format(data.unitAmount / 100));
      })
      .catch(() => {});
    return () => {
      if (canceledTimer !== null) window.clearTimeout(canceledTimer);
    };
  }, []);

  useEffect(() => {
    if (status === "loading") return;
    if (!session) return;
    fetch("/api/usage/check")
      .then((r) => r.json())
      .then((d) => { setIsSubscribed(!!d.isSubscribed || !!d.isAdmin); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [session, status]);
  const isLoading = status === "loading" || (!!session && loading);

  async function handleCheckout() {
    setMessage("");
    setWorking(true);
    const res = await fetch("/api/stripe/checkout", { method: "POST" });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
    else {
      setMessage(data.error ?? "Secure checkout is temporarily unavailable.");
      setWorking(false);
    }
  }

  async function handlePortal() {
    setMessage("");
    setWorking(true);
    const res = await fetch("/api/stripe/portal", { method: "POST" });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
    else {
      setMessage(data.error ?? "The billing portal is temporarily unavailable.");
      setWorking(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "#f5f1e8", display: "flex", flexDirection: "column", fontFamily: "'Courier New', monospace" }}>
    <main style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ maxWidth: 480, width: "100%", padding: 32 }}>
        <h1 style={{ fontFamily: "'Caveat', cursive", fontSize: 42, color: "#2a2a2a", marginBottom: 4, textAlign: "center" }}>
          Neural Board
        </h1>
        <p style={{ fontSize: 11, color: "#6a6a6a", textAlign: "center", marginBottom: 40, letterSpacing: 1 }}>
          UNLIMITED PLAN
        </p>

        <div style={{ background: "white", border: "1.5px solid #2a2a2a", padding: 32, marginBottom: 24, boxShadow: "4px 4px 0 #2a2a2a" }}>
          <div style={{ fontSize: 48, fontWeight: 700, color: "#2a2a2a", textAlign: "center", marginBottom: 4, fontFamily: "'Caveat', cursive" }}>
            {price ?? "Pro"}<span style={{ fontSize: 18, fontWeight: 400 }}>{price ? "/mo" : " monthly"}</span>
          </div>
          <p style={{ fontSize: 11, color: "#6a6a6a", textAlign: "center", marginBottom: 28, letterSpacing: 0.5 }}>
            cancel anytime
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: "0 0 28px", display: "flex", flexDirection: "column", gap: 10 }}>
            {[
              "Unlimited video exports",
              "AI clip finding and annotations",
              "AI image planning and search",
              "Smart camera and board tools",
            ].map((f) => (
              <li key={f} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "#2a2a2a" }}>
                <span style={{ color: "#c8f135", fontWeight: 700, fontSize: 16 }}>✓</span> {f}
              </li>
            ))}
          </ul>

          {message && (
            <div role="status" style={{ marginBottom: 14, padding: "9px 10px", border: "1.5px solid #2a2a2a", background: message.startsWith("Checkout canceled") ? "#fff3c4" : "#fff0ed", color: "#2a2a2a", fontSize: 11, lineHeight: 1.4 }}>
              {message}
            </div>
          )}

          {isLoading ? (
            <div style={{ textAlign: "center", fontSize: 12, color: "#6a6a6a" }}>loading...</div>
          ) : !session ? (
            <button onClick={() => signIn("google")} style={btnStyle}>
              Sign in to subscribe
            </button>
          ) : isSubscribed ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ textAlign: "center", padding: "10px 16px", background: "#d6ffd6", border: "1.5px solid #2a2a2a", fontSize: 12, fontWeight: 700, letterSpacing: 0.5 }}>
                ✓ SUBSCRIBED
              </div>
              <button onClick={handlePortal} disabled={working} style={{ ...btnStyle, background: "white", color: "#2a2a2a", border: "1.5px solid #2a2a2a" }}>
                {working ? "opening..." : "Manage subscription"}
              </button>
            </div>
          ) : (
            <button onClick={handleCheckout} disabled={working} style={btnStyle}>
              {working ? "redirecting..." : `Upgrade to Pro${price ? ` — ${price}/mo` : ""} →`}
            </button>
          )}
        </div>

        <p style={{ fontSize: 10, color: "#6a6a6a", textAlign: "center" }}>
          Free tier: 1 video export included with every account.
        </p>

        <div style={{ textAlign: "center", marginTop: 20 }}>
          <a href="/board2" style={{ fontSize: 11, color: "#2a2a2a", textDecoration: "underline" }}>
            ← back to board
          </a>
        </div>
      </div>
    </main>
    <LegalFooter />
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  display: "block", width: "100%", padding: "14px 20px",
  background: "#2a2a2a", color: "white", border: "1.5px solid #2a2a2a",
  fontSize: 13, fontWeight: 700, cursor: "pointer", letterSpacing: 0.5,
  fontFamily: "'Courier New', monospace",
};
