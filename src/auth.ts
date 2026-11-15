import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";

import { prisma } from "@/lib/db/prisma";

/**
 * Auth.js configuration (docs/security-architecture.md §2).
 *
 * Sessions are DATABASE sessions via the Prisma adapter, so they are
 * revocable: suspension deletes session rows, and getActorContext()
 * re-checks the account status and permissions from the database on
 * every request.
 *
 * Sign-in itself is the login Server Action
 * (src/app/(public)/login/actions.ts) calling the AuthenticationService:
 * the installed Auth.js version refuses to pair its Credentials provider
 * with the database session strategy (UnsupportedStrategy), so the
 * credential check is ours — bcrypt verification, login attempts,
 * lockout and audit in src/server/services/authentication.ts — while
 * Auth.js owns session resolution, cookie handling and expiry.
 * There is no public registration of any kind.
 */
export const { handlers, auth } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: {
    strategy: "database",
    maxAge: 7 * 24 * 60 * 60, // absolute lifetime: 7 days
    updateAge: 24 * 60 * 60, // idle refresh window: 24 hours
  },
  pages: { signIn: "/login" },
  providers: [],
  callbacks: {
    async session({ session, user }) {
      const dbUser = user as unknown as {
        id: string;
        email: string;
        fullName?: string;
        name?: string | null;
      };
      session.user.id = dbUser.id;
      session.user.email = dbUser.email;
      session.user.name = dbUser.fullName ?? dbUser.name ?? dbUser.email;
      return session;
    },
  },
});
