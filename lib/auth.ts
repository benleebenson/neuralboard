import { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { upsertUser } from "./supabase";

export const ADMIN_EMAIL = "bbtvhq@gmail.com";

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.AUTH_GOOGLE_ID!,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!,
    }),
  ],
  secret: process.env.AUTH_SECRET,
  pages: {
    signIn: "/",
  },
  callbacks: {
    async signIn({ user }) {
      if (user.email) {
        await upsertUser(user.email, user.name, user.image, user.email === ADMIN_EMAIL);
      }
      return true;
    },
  },
};

export function isAdmin(email: string | null | undefined): boolean {
  return email === ADMIN_EMAIL;
}
