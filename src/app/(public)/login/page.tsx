import { redirect } from "next/navigation";

import { getActorContext } from "@/lib/auth/permissions";
import { LoginForm } from "@/components/auth/LoginForm";

/**
 * The ONE login page for every role (docs/security-architecture.md §2),
 * styled in the preserved console token system. Already-authenticated
 * users are routed straight to their role dashboard.
 */
export default async function LoginPage() {
  const actor = await getActorContext();
  if (actor) redirect(actor.landingPath);

  return (
    <main className="flex min-h-screen items-center justify-center bg-page px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-5 text-center">
          <div className="text-[22px] font-bold leading-tight text-ink">BLA Logistics</div>
          <p className="mt-1 text-[13px] text-slate2">
            Sign in to the delivery operations platform
          </p>
        </div>
        <div className="rounded-lg border border-line bg-surface p-6">
          <LoginForm />
        </div>
        <p className="mt-4 text-center text-[12px] text-faint">
          Accounts are created by your administrator. There is no public sign-up.
        </p>
      </div>
    </main>
  );
}
