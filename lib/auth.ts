import { NextAuthOptions, Session } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import EmailProvider from "next-auth/providers/email";
import { upsertUser, getSubscriptionStatus } from "./supabase";
import { emailKeyedAdapter, emailSignInConfigured, sendMagicLinkEmail } from "./auth-email";
import { ADMIN_EMAIL } from "./admin";
export { ADMIN_EMAIL } from "./admin";

// Google, plus a passwordless magic link to any email address once Resend is configured
// (RESEND_API_KEY + EMAIL_FROM). The email provider needs an adapter for its verification tokens;
// see lib/auth-email.ts.
const emailEnabled = emailSignInConfigured();

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.AUTH_GOOGLE_ID!,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!,
    }),
    ...(emailEnabled ? [EmailProvider({
      from: process.env.EMAIL_FROM,
      maxAge: 24 * 60 * 60,
      sendVerificationRequest: ({ identifier, url }) => sendMagicLinkEmail({ identifier, url }),
    })] : []),
  ],
  ...(emailEnabled ? { adapter: emailKeyedAdapter() } : {}),
  // Explicit: with an adapter NextAuth would otherwise switch to database sessions.
  session: { strategy: "jwt" },
  secret: process.env.AUTH_SECRET,
  pages: {
    signIn: "/signin",
    verifyRequest: "/signin?check=1",
    error: "/signin",
  },
  callbacks: {
    async signIn({ user, email }) {
      // Requesting a magic link isn't signing in: don't create an account for an unverified address.
      if (email?.verificationRequest) return true;
      console.log("SIGNIN: callback fired, user.email =", user.email);
      if (user.email) {
        try {
          await upsertUser(user.email, user.name, user.image, user.email === ADMIN_EMAIL);
          console.log("SIGNIN: upsertUser completed successfully for", user.email);
        } catch (err) {
          console.log("SIGNIN: upsertUser threw an error for", user.email, err);
          throw err;
        }
      } else {
        console.log("SIGNIN: user.email is missing, skipping upsert. user =", JSON.stringify(user));
      }
      return true;
    },
  },
};

export function isAdmin(email: string | null | undefined): boolean {
  return email === ADMIN_EMAIL;
}

export async function isUserPro(session: Session | null): Promise<boolean> {
  if (!session?.user?.email) return false;
  const email = session.user.email;
  if (isAdmin(email)) return true;
  const { isSubscribed } = await getSubscriptionStatus(email);
  return isSubscribed;
}
