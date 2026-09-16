"use client";

import { signOut } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import styles from "./AccountControl.module.css";

const PRO_FEATURES = [
  "Unlimited video exports",
  "AI clip finding and annotations",
  "AI image planning and smart camera tools",
];

type BillingAction = "checkout" | "portal";

type AccountControlProps = {
  email: string;
  isPro: boolean;
  isAdmin?: boolean;
  isProLoading?: boolean;
  variant?: "dropdown" | "inline";
  onAction?: () => void;
};

function formatPrice(unitAmount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(unitAmount / 100);
}

export function AccountControl({
  email,
  isPro,
  isAdmin = false,
  isProLoading = false,
  variant = "dropdown",
  onAction,
}: AccountControlProps) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState<BillingAction | null>(null);
  const [error, setError] = useState("");
  const [price, setPrice] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isPro) return;
    let cancelled = false;
    void fetch("/api/stripe/price")
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((data: { unitAmount?: number; currency?: string }) => {
        if (!cancelled && typeof data.unitAmount === "number" && data.currency) {
          setPrice(formatPrice(data.unitAmount, data.currency));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isPro]);

  useEffect(() => {
    if (!open || variant !== "dropdown") return;
    function closeOnOutsideClick(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, variant]);

  async function openBilling(action: BillingAction) {
    setError("");
    setWorking(action);
    try {
      const response = await fetch(`/api/stripe/${action}`, { method: "POST" });
      const data = await response.json().catch(() => null) as { url?: string; error?: string } | null;
      if (!response.ok || !data?.url) {
        throw new Error(data?.error ?? "Billing is temporarily unavailable.");
      }
      window.location.assign(data.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Billing is temporarily unavailable.");
      setWorking(null);
    }
  }

  function closeThen(callback: () => void) {
    setOpen(false);
    onAction?.();
    callback();
  }

  const panel = (
    <div className={variant === "inline" ? styles.inlinePanel : styles.panel} role={variant === "dropdown" ? "dialog" : undefined} aria-label="Account and billing">
      <div className={styles.identity}>
        <div className={styles.email} title={email}>{email}</div>
        <span className={`${styles.status} ${isPro ? styles.pro : styles.free}`}>
          {isProLoading ? "…" : isAdmin ? "OWNER" : isPro ? "PRO" : "FREE"}
        </span>
      </div>

      {isAdmin ? (
        <div className={styles.section}>
          <p className={styles.copy}>Owner access is enabled. No Stripe subscription is required.</p>
        </div>
      ) : isPro ? (
        <div className={styles.section}>
          <p className={styles.copy}>Your Pro subscription is active.</p>
          <button
            type="button"
            className={styles.secondaryAction}
            disabled={working !== null}
            onClick={() => { void openBilling("portal"); }}
          >
            {working === "portal" ? "Opening portal…" : "Manage or cancel subscription"}
          </button>
        </div>
      ) : (
        <div className={styles.section}>
          <p className={styles.heading}>Upgrade to Pro{price ? ` · ${price}/month` : ""}</p>
          <ul className={styles.features}>
            {PRO_FEATURES.map((feature) => <li key={feature}>{feature}</li>)}
          </ul>
          <button
            type="button"
            className={styles.primaryAction}
            disabled={working !== null || isProLoading}
            onClick={() => { void openBilling("checkout"); }}
          >
            {working === "checkout" ? "Opening secure checkout…" : "Upgrade to Pro →"}
          </button>
        </div>
      )}

      {error && <p className={styles.error} role="alert">{error}</p>}

      <button
        type="button"
        className={styles.signOut}
        onClick={() => closeThen(() => { void signOut({ callbackUrl: "/" }); })}
      >
        Sign out
      </button>
    </div>
  );

  if (variant === "inline") return panel;

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.triggerEmail}>{email}</span>
        {!isProLoading && <span className={`${styles.triggerBadge} ${isPro ? styles.pro : styles.free}`}>{isAdmin ? "OWNER" : isPro ? "PRO" : "UPGRADE"}</span>}
        <span aria-hidden="true">⌄</span>
      </button>
      {open && panel}
    </div>
  );
}

export function CheckoutReturnNotice({ isPro }: { isPro: boolean }) {
  const [returnedFromCheckout, setReturnedFromCheckout] = useState(false);
  const [activated, setActivated] = useState(isPro);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const didUpgrade = new URLSearchParams(window.location.search).get("upgraded") === "1";
    if (!didUpgrade) return;

    let cancelled = false;
    const revealTimer = window.setTimeout(() => setReturnedFromCheckout(true), 0);
    if (isPro) return () => window.clearTimeout(revealTimer);
    let attempts = 0;
    const check = async () => {
      attempts += 1;
      try {
        const response = await fetch("/api/user/me", { cache: "no-store" });
        const data = response.ok ? await response.json() as { isPro?: boolean } : null;
        if (!cancelled && data?.isPro) {
          setActivated(true);
          window.dispatchEvent(new CustomEvent("neuralboard:pro-status", { detail: true }));
          return;
        }
      } catch {}
      if (cancelled) return;
      if (attempts >= 15) {
        setTimedOut(true);
        return;
      }
      window.setTimeout(check, 1000);
    };
    void check();
    return () => {
      cancelled = true;
      window.clearTimeout(revealTimer);
    };
  }, [isPro]);

  if (!returnedFromCheckout) return null;

  function dismiss() {
    const url = new URL(window.location.href);
    url.searchParams.delete("upgraded");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    setReturnedFromCheckout(false);
  }

  return (
    <div className={`${styles.checkoutNotice} ${activated || isPro ? styles.checkoutSuccess : ""}`} role="status" aria-live="polite">
      <span>
        {activated || isPro
          ? "✓ Welcome to Pro — your features are unlocked."
          : timedOut
            ? "Payment returned successfully, but Pro is still syncing. Refresh shortly or check the webhook in Stripe."
            : "Payment returned successfully — activating Pro…"}
      </span>
      <button type="button" onClick={dismiss} aria-label="Dismiss payment status">×</button>
    </div>
  );
}
