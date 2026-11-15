import { redirect } from "next/navigation";
import QRCode from "qrcode";

import { getActorContext } from "@/lib/auth/permissions";
import { MfaSetupForm } from "@/components/auth/MfaSetupForm";
import { beginMfaEnrolment } from "@/server/services/mfa";

/**
 * TOTP enrolment (Phase 10 gate F13). Privileged accounts
 * (SUPER_ADMIN/ADMIN) land here at first login while the MFA policy
 * requires enrolment; the session is restricted to this flow (plus
 * password change and sign-out) until a valid code activates MFA.
 * Not part of a role route group — the guard is enforced here.
 */
export default async function MfaSetupPage() {
  const actor = await getActorContext();
  if (!actor) redirect("/login");
  if (actor.mustChangePassword) redirect("/set-password");
  if (actor.mfaPending) redirect("/login/mfa");
  if (!actor.mfaEnrolmentRequired) redirect("/go");

  const enrolment = await beginMfaEnrolment(actor);
  const qrDataUrl = await QRCode.toDataURL(enrolment.otpauthUrl, { margin: 1, width: 220 });

  return (
    <main className="flex min-h-screen items-center justify-center bg-page px-4 py-10">
      <div className="w-full max-w-[420px]">
        <div className="mb-5 text-center">
          <div className="text-[22px] font-bold leading-tight text-ink">BLA Logistics</div>
          <p className="mt-1 text-[13px] text-slate2">
            Set up two-factor authentication to continue
          </p>
        </div>
        <div className="rounded-lg border border-line bg-surface p-6">
          <p className="mb-4 text-[13px] leading-relaxed text-ink">
            Your role requires an authenticator app (Google Authenticator, Microsoft
            Authenticator, or any TOTP app). Scan the code, then enter the 6-digit code
            the app shows to activate.
          </p>
          <div className="mb-4 flex justify-center">
            {/* QR for the otpauth URL; the manual key below is the fallback. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrDataUrl} alt="Authenticator enrolment QR code" width={220} height={220} />
          </div>
          <div className="mb-5 rounded-md border border-line bg-page px-3 py-2 text-center">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
              Manual key
            </div>
            <div className="mt-1 break-all font-mono text-[13px] text-ink">
              {enrolment.secretBase32}
            </div>
          </div>
          <MfaSetupForm />
          <p className="mt-4 text-[12px] leading-relaxed text-faint">
            If you lose access to your authenticator, another Super Admin can reset your
            enrolment from user management.
          </p>
        </div>
      </div>
    </main>
  );
}
