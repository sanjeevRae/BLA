import { TrackForm } from "@/components/tracking/TrackForm";

/** Public tracking landing (docs/security-architecture.md §7):
 *  unauthenticated; the tracking code is the only input. */
export default function Page() {
  return (
    <main className="mx-auto flex min-h-screen max-w-[560px] flex-col justify-center px-5 py-10">
      <h1 className="text-[24px] font-bold text-ink">Track your parcel</h1>
      <p className="mt-2 text-[13px] leading-relaxed text-slate2">
        Enter the tracking code from your receipt or package label (for example
        BLA-4839201756). You will see the parcel&apos;s status, its public progress timeline and
        the destination district — no account needed.
      </p>
      <div className="mt-5">
        <TrackForm />
      </div>
    </main>
  );
}
