import { redirect } from "next/navigation";

import { getActorContext } from "@/lib/auth/permissions";
import { LoginForm } from "@/components/auth/LoginForm";
import { BrandMark } from "@/components/layout/BrandMark";

/**
 * The ONE login page for every role (docs/security-architecture.md §2),
 * styled in the preserved console token system. Already-authenticated
 * users are routed straight to their role dashboard.
 *
 * V3 Step 9 (DS §2.6): split treatment — left panel in `sidebar`
 * carrying the shared BrandMark + wordmark and the existing product
 * line; right panel the form on white. On mobile the dark panel
 * collapses to a top band.
 */
export default async function LoginPage() {
  const actor = await getActorContext();
  if (actor) {
    // Already signed in: route onward, honouring the same restricted
    // states the login action routes on (Phase 10 gate F13).
    if (actor.mfaEnrolmentRequired) redirect("/mfa-setup");
    if (actor.mfaPending) redirect("/login/mfa");
    redirect(actor.landingPath);
  }

  return (
    <main className="flex min-h-screen flex-col bg-page lg:flex-row">
      <section
        aria-label="BLA Logistics"
        className="flex w-full shrink-0 flex-col justify-center bg-sidebar px-6 py-8 text-sidebar-text lg:w-[42%] lg:max-w-[520px] lg:px-10 lg:py-12"
      >
        <div className="mx-auto w-full max-w-[380px] lg:mx-0">
          <div className="flex items-center gap-3">
            <BrandMark markSize={40} />
          </div>
          <p className="mt-4 text-[14px] leading-relaxed text-sidebar-text lg:mt-6">
            Delivery operations platform
          </p>
        </div>
      </section>
      <section className="flex flex-1 items-center justify-center bg-card px-4 py-10 sm:px-6">
        <div className="w-full max-w-[380px]">
          <div className="mb-5">
            <h1 className="text-[22px] font-semibold leading-tight text-ink">
              Sign in
            </h1>
            <p className="mt-1 text-[13px] text-ink-2">
              Use your organisation account to continue.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card p-6">
            <LoginForm />
          </div>
          <p className="mt-4 text-center text-[12px] text-ink-2">
            Accounts are created by your administrator. There is no public sign-up.
          </p>
        </div>
      </section>
    </main>
  );
}
