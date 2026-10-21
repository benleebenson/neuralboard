"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { LogoMark } from "@/app/components/AppShell";
import styles from "@/app/components/AppShell.module.css";
import { shellFont } from "@/app/components/shell-font";

// NextAuth error codes that can reach this page, in plain words.
const ERROR_MESSAGES: Record<string, string> = {
  EmailSignin: "We couldn’t send the sign-in email. Check the address and try again.",
  Verification: "That sign-in link has expired or was already used. Request a new one below.",
  OAuthSignin: "Google sign-in didn’t start. Please try again.",
  OAuthCallback: "Google sign-in didn’t finish. Please try again.",
  AccessDenied: "That account can’t sign in.",
};

// Where to land after signing in: same-site paths only (NextAuth passes full URLs for the
// current page); anything else goes Home.
function sameSiteDestination(requested: string): string {
  if (requested.startsWith("/") && !requested.startsWith("//")) return requested;
  try {
    const url = new URL(requested);
    if (url.origin === window.location.origin) return `${url.pathname}${url.search}${url.hash}`;
  } catch {}
  return "/";
}

export function SignInPanel({ callbackUrl: requestedCallbackUrl, error, checkEmail, emailEnabled }: {
  callbackUrl: string;
  error: string;
  checkEmail: boolean;
  emailEnabled: boolean;
}) {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(checkEmail ? "" : null);
  const [message, setMessage] = useState(error ? ERROR_MESSAGES[error] ?? "Sign-in didn’t work. Please try again." : "");

  async function sendLink(event: React.FormEvent) {
    event.preventDefault();
    const address = email.trim();
    if (!address) return;
    setSending(true);
    setMessage("");
    const result = await signIn("email", { email: address, callbackUrl: sameSiteDestination(requestedCallbackUrl), redirect: false });
    setSending(false);
    if (result?.error) setMessage(ERROR_MESSAGES[result.error] ?? ERROR_MESSAGES.EmailSignin);
    else setSentTo(address);
  }

  return (
    <main className={`${styles.shell} ${shellFont.variable} ${styles.signInPage}`}>
      <section className={styles.joinCard} aria-labelledby="signin-title">
        <div className={styles.brand}><LogoMark /><span>NeuralBoard</span></div>
        {sentTo !== null ? (
          <>
            <h1 id="signin-title" className={styles.joinTitle}>Check your email</h1>
            <p className={styles.joinLead}>
              {sentTo ? <>We sent a sign-in link to <strong>{sentTo}</strong>.</> : "We sent you a sign-in link."} Open it on this device to finish signing in.
            </p>
            <p className={styles.caption}>No email? Check spam, or <button type="button" className={styles.inlineLink} onClick={() => setSentTo(null)}>try again</button>.</p>
          </>
        ) : (
          <>
            <h1 id="signin-title" className={styles.joinTitle}>Sign in</h1>
            <p className={styles.joinLead}>Save boards to your account and use them anywhere.</p>
            {message && <p role="alert" className={styles.error}>{message}</p>}
            <button type="button" className={styles.outlineButton} onClick={() => { void signIn("google", { callbackUrl: sameSiteDestination(requestedCallbackUrl) }); }}>
              <GoogleMark />
              Continue with Google
            </button>
            {emailEnabled && (
              <>
                <div className={styles.signInDivider}><span>or</span></div>
                <form className={styles.signInForm} onSubmit={sendLink}>
                  <input
                    className={styles.emailInput}
                    type="email"
                    name="email"
                    autoComplete="email"
                    inputMode="email"
                    required
                    aria-label="Email address"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                  <button type="submit" className={styles.gradientButton} disabled={sending || !email.trim()}>
                    {sending ? "Sending…" : "Continue with Email"}
                  </button>
                </form>
                <p className={styles.caption}>We’ll email you a link to sign in. No password needed.</p>
              </>
            )}
          </>
        )}
      </section>
    </main>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.5z" />
    </svg>
  );
}
