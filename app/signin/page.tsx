import type { Metadata } from "next";
import { emailSignInConfigured } from "@/lib/auth-email";
import { SignInPanel } from "./SignInPanel";

export const metadata: Metadata = { title: "Sign in · Neural Board" };

// NextAuth's sign-in, "check your email" and error page (see pages in lib/auth.ts).
export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";
  return (
    <SignInPanel
      callbackUrl={first(params.callbackUrl)}
      error={first(params.error)}
      checkEmail={first(params.check) === "1"}
      emailEnabled={emailSignInConfigured()}
    />
  );
}
