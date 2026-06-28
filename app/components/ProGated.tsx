"use client";

import React, { useState } from "react";
import { useIsPro } from "./useIsPro";

const PRO_FEATURES = [
  "AI-generated clip annotations",
  "Unlimited video exports",
  "AI board arrangement",
  "All future Pro features",
];

function UpgradeModal({ featureName, onClose }: { featureName: string; onClose: () => void }) {
  const [working, setWorking] = useState(false);

  async function handleUpgrade() {
    setWorking(true);
    const res = await fetch("/api/stripe/checkout", { method: "POST" });
    const data = await res.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      setWorking(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "rgba(0,0,0,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#fffdf5",
          border: "2px solid #2a2a2a",
          boxShadow: "6px 6px 0 #2a2a2a",
          padding: 32,
          maxWidth: 400,
          width: "calc(100% - 48px)",
          fontFamily: "'Courier New', monospace",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 11, letterSpacing: 1, color: "#6a6a6a", marginBottom: 8 }}>
          PRO FEATURE
        </div>
        <h2 style={{ fontFamily: "'Caveat', cursive", fontSize: 32, color: "#2a2a2a", margin: "0 0 6px" }}>
          Upgrade to Pro
        </h2>
        <p style={{ fontSize: 12, color: "#6a6a6a", margin: "0 0 20px" }}>
          {featureName} requires a Pro subscription.
        </p>

        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 24px", display: "flex", flexDirection: "column", gap: 8 }}>
          {PRO_FEATURES.map((f) => (
            <li key={f} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#2a2a2a" }}>
              <span style={{ color: "#c8f135", fontWeight: 700 }}>✓</span> {f}
            </li>
          ))}
        </ul>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            onClick={handleUpgrade}
            disabled={working}
            style={{
              padding: "12px 20px",
              background: "#2a2a2a", color: "white",
              border: "1.5px solid #2a2a2a",
              fontSize: 13, fontWeight: 700, cursor: working ? "wait" : "pointer",
              letterSpacing: 0.5, fontFamily: "'Courier New', monospace",
            }}
          >
            {working ? "redirecting..." : "Upgrade to Pro — $10/mo →"}
          </button>
          <button
            onClick={onClose}
            style={{
              padding: "10px 20px",
              background: "transparent", color: "#6a6a6a",
              border: "1.5px solid #ccc",
              fontSize: 12, cursor: "pointer",
              fontFamily: "'Courier New', monospace",
            }}
          >
            Maybe later
          </button>
        </div>
      </div>
    </div>
  );
}

// Inline upgrade prompt — use as the `fallback` prop in ProGated
export function UpgradePrompt({ featureName }: { featureName?: string }) {
  const [showModal, setShowModal] = useState(false);
  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "6px 12px",
          background: "#f5f1e8", color: "#2a2a2a",
          border: "1.5px solid #2a2a2a",
          fontSize: 11, fontWeight: 700, cursor: "pointer",
          letterSpacing: 0.5, fontFamily: "'Courier New', monospace",
        }}
      >
        <span style={{ fontSize: 10 }}>★</span> PRO
      </button>
      {showModal && (
        <UpgradeModal
          featureName={featureName ?? "This feature"}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}

interface ProGatedProps {
  featureName: string;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

// Usage:
//   <ProGated featureName="AI Annotations">
//     <button onClick={generate}>Generate</button>
//   </ProGated>
//
//   <ProGated featureName="AI Annotations" fallback={<UpgradePrompt featureName="AI Annotations" />}>
//     <button onClick={generate}>Generate</button>
//   </ProGated>
export function ProGated({ featureName, children, fallback }: ProGatedProps) {
  const { isPro, loading } = useIsPro();
  const [showModal, setShowModal] = useState(false);

  // Show children normally while loading or when Pro
  if (loading || isPro) return <>{children}</>;

  // Non-Pro + custom fallback provided
  if (fallback != null) return <>{fallback}</>;

  // Non-Pro + no fallback: grey out children, intercept clicks
  return (
    <>
      <div style={{ position: "relative", display: "inline-block" }}>
        <div style={{ opacity: 0.45, pointerEvents: "none", userSelect: "none" }}>
          {children}
        </div>
        <div
          style={{
            position: "absolute", inset: 0,
            cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onClick={() => setShowModal(true)}
          title={`${featureName} — Pro feature`}
        />
      </div>
      {showModal && (
        <UpgradeModal featureName={featureName} onClose={() => setShowModal(false)} />
      )}
    </>
  );
}
