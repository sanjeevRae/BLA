import Link from "next/link";

import { formatPaisa } from "@/components/bookings/ui";
import { StatusBadge } from "@/components/ui/StatusBadge";

/**
 * Phase 6 (V2) rider home — presentational pieces.
 *
 * Pure components (no service imports) so the summary strip and
 * failed-attempt emphasis are component-testable, and so the
 * server page (RiderHomePage in pages.tsx) only composes them.
 * Mobile-first rules for this home: primary job actions are
 * ≥48px tall, primary job text is ≥14px, everything stacks in a
 * single column — no data tables.
 */

export const riderPrimaryActionClass =
  "flex min-h-[48px] items-center justify-center rounded-md bg-brand px-4 text-[14px] font-semibold text-white";
export const riderSubtleActionClass =
  "flex min-h-[48px] items-center justify-center rounded-md border border-line bg-surface px-4 text-[14px] font-semibold text-ink";

export interface RiderTodayStripProps {
  assigned: number;
  delivered: number;
  remaining: number;
  failedAttemptsNeedingAction: number;
}

function StripTile({
  label,
  value,
  danger = false,
  testId,
}: {
  label: string;
  value: number;
  danger?: boolean;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`rounded-lg border border-line px-3 py-3 ${danger ? "bg-redbg" : "bg-surface"}`}
    >
      <div
        className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${danger ? "text-reddeep" : "text-slate2"}`}
      >
        {label}
      </div>
      <div className={`tnum mt-1 text-[22px] font-bold ${danger ? "text-reddeep" : "text-ink"}`}>
        {value}
      </div>
    </div>
  );
}

export function RiderTodayStrip({
  assigned,
  delivered,
  remaining,
  failedAttemptsNeedingAction,
}: RiderTodayStripProps) {
  return (
    <div className="grid grid-cols-2 gap-3" aria-label="Today's summary">
      <StripTile label="Assigned stops" value={assigned} />
      <StripTile label="Delivered" value={delivered} />
      <StripTile label="Remaining" value={remaining} />
      <StripTile
        label="Failed — need action"
        value={failedAttemptsNeedingAction}
        danger={failedAttemptsNeedingAction > 0}
        testId="rider-failed-tile"
      />
    </div>
  );
}

export interface RiderFailedAttemptItem {
  attemptId: string;
  assignmentId: string;
  batchId: string | null;
  trackingId: string;
  result: string;
  failureReason: string | null;
  nextAction: string;
  attemptedAt: string;
  recipientArea: string;
  codExpectedPaisa: string;
}

export function RiderFailedAttemptsList({ attempts }: { attempts: RiderFailedAttemptItem[] }) {
  if (attempts.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {attempts.map((a) => (
        <div
          key={a.attemptId}
          className="rounded-lg border border-line bg-redbg px-3 py-3 transition-colors active:border-danger"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[14px] font-semibold text-ink">{a.trackingId}</span>
            <StatusBadge domain="generic" status={a.result} />
          </div>
          <p className="mt-1 text-[14px] text-ink">
            {a.failureReason ?? a.result.replaceAll("_", " ")}
            {a.recipientArea ? ` · ${a.recipientArea}` : ""}
            {BigInt(a.codExpectedPaisa) > BigInt(0)
              ? ` · COD due ${formatPaisa(BigInt(a.codExpectedPaisa))}`
              : ""}
          </p>
          <p className="mt-0.5 text-[13px] font-semibold text-ink">
            Next action: {a.nextAction.replaceAll("_", " ")} ·{" "}
            {new Date(a.attemptedAt).toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
          <Link
            href={a.batchId ? `/rider/batches/${a.batchId}` : "/rider"}
            className={`mt-3 ${riderPrimaryActionClass}`}
          >
            Open stop — re-attempt or call recipient →
          </Link>
        </div>
      ))}
    </div>
  );
}

export interface RiderNextStop {
  assignmentId: string;
  trackingId: string;
  status: string;
  recipientName: string;
  recipientArea: string;
  codExpectedPaisa: string;
}

export function RiderCurrentBatchCard({
  batchId,
  warehouseCode,
  batchDate,
  batchStatus,
  totalPackages,
  deliveredPackages,
  nextStop,
}: {
  batchId: string;
  warehouseCode: string;
  batchDate: string;
  batchStatus: string;
  totalPackages: number;
  deliveredPackages: number;
  nextStop: RiderNextStop | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-semibold text-ink">
          {warehouseCode} · {batchDate}
        </span>
        <StatusBadge domain="generic" status={batchStatus} />
        <span className="text-[13px] text-slate2">
          {deliveredPackages} of {totalPackages} delivered
        </span>
      </div>
      {nextStop ? (
        <div className="rounded-lg border border-line bg-cream px-3 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
            Next stop
          </div>
          <div className="mt-1 font-mono text-[14px] font-semibold text-ink">
            {nextStop.trackingId}
          </div>
          <p className="mt-0.5 text-[14px] text-ink">
            {nextStop.recipientName}
            {nextStop.recipientArea ? ` · ${nextStop.recipientArea}` : ""}
            {BigInt(nextStop.codExpectedPaisa) > BigInt(0)
              ? ` · COD due ${formatPaisa(BigInt(nextStop.codExpectedPaisa))}`
              : " · No COD due"}
          </p>
        </div>
      ) : (
        <p className="text-[14px] text-ink">Every stop on this batch is accounted for.</p>
      )}
      <Link href={`/rider/batches/${batchId}`} className={riderPrimaryActionClass}>
        Open batch — work this run →
      </Link>
    </div>
  );
}

export interface RiderCustodyItem {
  id: string;
  trackingId: string;
  packageStatus: string;
  startedAt: string;
}

export function RiderCustodyList({ items }: { items: RiderCustodyItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-[14px] text-ink">
        Nothing in your custody right now. Packages you pick up appear here until they are
        delivered or handed back.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex min-h-[48px] flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2"
        >
          <span className="font-mono text-[14px] font-semibold text-ink">{item.trackingId}</span>
          <StatusBadge domain="operational" status={item.packageStatus} />
          <span className="text-[13px] text-slate2">
            since{" "}
            {new Date(item.startedAt).toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function RiderCodCard({
  collectedTodayPaisa,
  handedOverPaisa,
  toRemitPaisa,
}: {
  collectedTodayPaisa: string;
  handedOverPaisa: string;
  toRemitPaisa: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-1 gap-2 text-[14px] min-[420px]:grid-cols-3">
        <div>
          <dt className="text-[13px] text-slate2">Collected today</dt>
          <dd className="tnum font-semibold text-ink">{formatPaisa(BigInt(collectedTodayPaisa))}</dd>
        </div>
        <div>
          <dt className="text-[13px] text-slate2">Handed over (verified)</dt>
          <dd className="tnum font-semibold text-ink">{formatPaisa(BigInt(handedOverPaisa))}</dd>
        </div>
        <div>
          <dt className="text-[13px] text-slate2">To remit</dt>
          <dd className="tnum font-semibold text-ink">{formatPaisa(BigInt(toRemitPaisa))}</dd>
        </div>
      </dl>
      <Link href="/rider/cod" className={riderSubtleActionClass}>
        Your COD obligations →
      </Link>
    </div>
  );
}
