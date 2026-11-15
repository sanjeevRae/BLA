import { AcceptInvitationForm } from "@/components/auth/AcceptInvitationForm";

/**
 * Invitation acceptance page. The token in the link is the credential —
 * it is single-use, expires after 7 days, and only its hash is stored
 * (docs/security-architecture.md §5). There is no other public sign-up.
 */
export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center bg-page px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-5 text-center">
          <div className="text-[22px] font-bold leading-tight text-ink">BLA Logistics</div>
          <p className="mt-1 text-[13px] text-slate2">
            You have been invited to join the platform
          </p>
        </div>
        <div className="rounded-lg border border-line bg-surface p-6">
          <AcceptInvitationForm token={token ?? ""} />
        </div>
      </div>
    </main>
  );
}
