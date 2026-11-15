"use server";

import { redirect } from "next/navigation";

import { destroyDatabaseSession } from "@/lib/auth/session-cookie";

/** Sign out: the session row is deleted server-side, then the cookie cleared. */
export async function logoutAction(): Promise<void> {
  await destroyDatabaseSession();
  redirect("/login");
}
