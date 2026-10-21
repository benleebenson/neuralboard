import type { Adapter, AdapterUser, VerificationToken } from "next-auth/adapters";
import { getSupabase } from "./supabase";

// Magic-link email sign-in needs somewhere to keep verification tokens, which in NextAuth v4
// means an adapter. This one stores only those tokens (public.verification_tokens). Users stay
// keyed by email in nb_users and sessions stay JWT, so it never looks users up: every sign-in —
// Google or email — is the user identified by that email, and Google sign-in works exactly as it
// did before there was an adapter.
export function emailKeyedAdapter(): Adapter {
  return {
    async createUser(user: Omit<AdapterUser, "id">) {
      return { ...user, id: user.email } as AdapterUser;
    },
    async getUser() {
      return null;
    },
    async getUserByEmail() {
      return null;
    },
    async getUserByAccount() {
      return null;
    },
    async updateUser(user) {
      return { emailVerified: null, ...user, id: user.id, email: user.email ?? user.id } as AdapterUser;
    },
    async linkAccount() {},
    async createVerificationToken(verificationToken) {
      const { error } = await getSupabase().from("verification_tokens").insert({
        identifier: verificationToken.identifier,
        token: verificationToken.token,
        expires: verificationToken.expires.toISOString(),
      });
      if (error) throw error;
      return verificationToken;
    },
    // Single use: deleting and returning in one statement means a link can't be used twice.
    async useVerificationToken({ identifier, token }): Promise<VerificationToken | null> {
      const { data, error } = await getSupabase().from("verification_tokens")
        .delete().eq("identifier", identifier).eq("token", token)
        .select("identifier,token,expires").maybeSingle();
      if (error) throw error;
      return data ? { identifier: data.identifier, token: data.token, expires: new Date(data.expires) } : null;
    },
  };
}

export function emailSignInConfigured(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.EMAIL_FROM;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

// Sends the sign-in link through Resend's REST API (https://resend.com/docs/api-reference/emails/send-email).
export async function sendMagicLinkEmail({ identifier, url }: { identifier: string; url: string }): Promise<void> {
  const host = new URL(url).host;
  const safeUrl = escapeHtml(url);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: identifier,
      subject: "Sign in to Neural Board",
      text: `Sign in to Neural Board (${host}):\n\n${url}\n\nThis link works once and expires in 24 hours. If you didn't ask for it, you can ignore this email.`,
      html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#2f3533">
  <h1 style="font-size:20px;margin:0 0 12px">Sign in to Neural Board</h1>
  <p style="margin:0 0 20px;line-height:1.5">Click the button to sign in as <strong>${escapeHtml(identifier)}</strong>.</p>
  <p style="margin:0 0 24px"><a href="${safeUrl}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:#1e8c83;color:#ffffff;text-decoration:none;font-weight:600">Sign in</a></p>
  <p style="margin:0;font-size:13px;line-height:1.5;color:#6b7370">This link works once and expires in 24 hours. If you didn't ask for it, you can ignore this email.</p>
</div>`,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Resend rejected the sign-in email (${response.status}): ${detail.slice(0, 300)}`);
  }
}
