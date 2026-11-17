import { TrackForm } from "@/components/tracking/TrackForm";

/** Public tracking landing (docs/security-architecture.md §7):
 *  unauthenticated; the tracking code is the only input. */
export default function Page() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[560px] flex-col justify-center px-5 py-10">
      <h1 className="text-page-title font-semibold text-ink">Track your parcel</h1>
      <p className="mt-2 text-body leading-relaxed text-ink-2">
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
