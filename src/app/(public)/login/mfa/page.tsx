import { redirect } from "next/navigation";

import { getActorContext } from "@/lib/auth/permissions";
import { MfaChallengeForm } from "@/components/auth/MfaChallengeForm";

/**
 * The TOTP challenge step of the single login flow (Phase 10 gate
 * F13). Reached only with an MFA-pending session: the password was
 * accepted, the session exists, and every other surface refuses the
 * actor until the challenge stamps the session. Not part of a role
 * route group — the guard is enforced here.
 */
export default async function MfaChallengePage() {
  const actor = await getActorContext();
  if (!actor) redirect("/login");
  if (actor.mustChangePassword) redirect("/set-password");
  if (actor.mfaEnrolmentRequired) redirect("/mfa-setup");
  if (!actor.mfaPending) redirect("/go");

  return (
    <main className="flex min-h-screen items-center justify-center bg-page px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-5 text-center">
          <div className="text-[22px] font-bold leading-tight text-ink">BLA Logistics</div>
          <p className="mt-1 text-[13px] text-slate2">Two-factor authentication</p>
        </div>
        <div className="rounded-lg border border-line bg-surface p-6">
          <p className="mb-4 text-[13px] leading-relaxed text-ink">
            Enter the 6-digit code from your authenticator app to finish signing in.
          </p>
          <MfaChallengeForm />
          <p className="mt-4 text-[12px] leading-relaxed text-faint">
            Too many failed attempts will end this sign-in and ask for your password
            again. If you have lost your authenticator, another Super Admin can reset
            your enrolment.
          </p>
        </div>
      </div>
    </main>
  );
}
