import Link from "next/link";

/** Root not-found state for public routes (V2 Phase 1). */
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-page px-4">
      <div className="w-full max-w-[440px] rounded-lg border border-line bg-surface px-5 py-6 text-center">
        <h1 className="text-[18px] font-bold text-ink">Page not found</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate2">
          This address does not match any page. Check the link, or track a
          package instead.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Link
            href="/track"
            className="flex min-h-[44px] items-center rounded-md bg-brand px-4 text-[13px] font-semibold text-white hover:opacity-90"
          >
            Track a package
          </Link>
          <Link
            href="/login"
            className="flex min-h-[44px] items-center rounded-md border border-line bg-surface px-4 text-[13px] font-semibold text-ink hover:bg-cream"
          >
            Sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
