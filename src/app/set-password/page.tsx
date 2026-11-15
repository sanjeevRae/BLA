import { redirect } from "next/navigation";

import { getActorContext } from "@/lib/auth/permissions";
import { SetPasswordForm } from "@/components/auth/SetPasswordForm";

/**
 * Set/change password. Reachable by every signed-in role; the login
 * flow and every dashboard guard send mustChangePassword accounts here
 * before anything else renders. Not part of a role route group, so the
 * guard is enforced here directly.
 */
export default async function SetPasswordPage() {
  const actor = await getActorContext();
  if (!actor) redirect("/login");

  return (
    <main className="flex min-h-screen items-center justify-center bg-page px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-5 text-center">
          <div className="text-[22px] font-bold leading-tight text-ink">BLA Logistics</div>
          <p className="mt-1 text-[13px] text-slate2">
            {actor.mustChangePassword ? "Set a new password to continue" : "Change your password"}
          </p>
        </div>
        <div className="rounded-lg border border-line bg-surface p-6">
          <SetPasswordForm forced={actor.mustChangePassword} />
        </div>
      </div>
    </main>
  );
}
