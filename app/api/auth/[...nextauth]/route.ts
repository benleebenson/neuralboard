import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";
import { upsertUser, logEvent } from "@/lib/supabase";

const handler = NextAuth({
  ...authOptions,
  events: {
    signIn: async ({ user }) => {
      if (user.email) {
        await upsertUser(user.email, user.name, user.image).catch(() => {});
        await logEvent(user.email, "login").catch(() => {});
      }
    },
  },
});

export { handler as GET, handler as POST };
