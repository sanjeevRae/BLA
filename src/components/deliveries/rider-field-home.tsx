import Link from "next/link";

import { hasPermission, type ActorContext } from "@/lib/auth/actor";
import { formatDateTime, formatPaisa } from "@/components/bookings/ui";
import { NavIcon } from "@/components/layout/icons";
import { DriverAssignmentIncidentForm } from "@/components/operations/forms";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { PriorityBadge, StatusBadge } from "@/components/ui/StatusBadge";
import { SectionCard } from "@/components/warehouses/ui";
import {
  riderPrimaryActionClass,
  riderSubtleActionClass,
} from "@/components/deliveries/rider-home";
import {
  getRiderFieldHome,
  type RiderFieldHomeData,
  type RiderJobCardData,
} from "@/server/services/home-dashboards";

/**
 * Rider field home (V3 Step 6) — mobile-first single column built on
 * the V3 primitives, fed entirely by the composed read model
 * (`getRiderFieldHome`): today's summary, failed attempts needing
 * action, per-batch job cards in route order, the COD position (same
 * reads the COD pages use), custody and open tasks.
 *
 * Field rules: every action is a ≥48px touch target, recipient /
 * address / COD text is ≥16px, and there are no density toggles —
 * this surface is used one-handed, outdoors, on a phone.
 */

const touchLinkClass =
  "flex min-h-[48px] items-center justify-center rounded-md border border-line bg-surface px-4 text-[15px] font-semibold text-ink";
const touchPrimaryLinkClass =
  "flex min-h-[48px] items-center justify-center rounded-md bg-brand px-4 text-[15px] font-semibold text-white";

function formatDay(date: string): string {
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function JobCard({
  job,
  canReportIncident,
}: {
  job: RiderJobCardData;
  canReportIncident: boolean;
}) {
  const codDue = BigInt(job.codDuePaisa);
  return (
    <article
      data-testid="rider-job-card"
      className={`rounded-lg border bg-surface px-4 py-3 transition-colors active:border-primary-dark ${
        job.isNext ? "border-primary ring-1 ring-primary" : "border-line"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[16px] font-semibold text-ink">{job.recipientName}</span>
        {job.isNext ? (
          <span className="rounded-full bg-brand px-2.5 py-1 text-[12px] font-semibold text-white">
            Next stop
          </span>
        ) : null}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[14px] font-semibold text-ink">{job.trackingId}</span>
        <StatusBadge domain="generic" status={job.status} />
        <StatusBadge domain="operational" status={job.packageStatus} />
      </div>

      <p className="mt-2 text-[16px] leading-snug text-ink">
        {job.address}
        {job.landmark ? (
          <span className="text-slate2"> (near {job.landmark})</span>
        ) : null}
      </p>
      {job.city || job.district ? (
        <p className="text-[15px] text-slate2">
          {[job.city, job.district].filter(Boolean).join(" · ")}
        </p>
      ) : null}

      {job.deliveryInstructions ? (
        <p className="mt-1.5 text-[15px] text-ink">
          Instructions: {job.deliveryInstructions}
        </p>
      ) : null}
      {job.failedAttempts > 0 ? (
        <p className="mt-1 text-[14px] font-medium text-reddeep">
          {job.failedAttempts} failed attempt(s) so far
        </p>
      ) : null}

      {codDue > BigInt(0) || job.codCollectedPaisa !== null ? (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          {codDue > BigInt(0) ? (
            <p className="text-[16px] text-ink">
              COD due{" "}
              <span className="font-semibold">{formatPaisa(codDue)}</span>
            </p>
          ) : null}
          {job.codCollectedPaisa !== null ? (
            <p className="text-[15px] font-semibold text-success">
              Collected {formatPaisa(BigInt(job.codCollectedPaisa))}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <a href={`tel:${job.recipientPhone.replaceAll(" ", "")}`} className={touchPrimaryLinkClass}>
          Call {job.recipientPhone}
        </a>
        {job.recipientAltPhone ? (
          <a
            href={`tel:${job.recipientAltPhone.replaceAll(" ", "")}`}
            className={touchLinkClass}
          >
            Call {job.recipientAltPhone}
          </a>
        ) : null}
        <Link href={`/rider/batches/${job.batchId}`} className={touchLinkClass}>
          Open in batch →
        </Link>
      </div>

      {job.isNext && canReportIncident ? (
        <div className="mt-3">
          <DriverAssignmentIncidentForm assignmentId={job.assignmentId} packageId={job.packageId} />
        </div>
      ) : null}
    </article>
  );
}

export function RiderFieldHomeView({
  data,
  canReportIncident,
}: {
  data: RiderFieldHomeData;
  canReportIncident: boolean;
}) {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Delivery Rider"
        title="Today's deliveries"
        description={`${data.riderName} · ${formatDay(data.date)}`}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Today's summary">
        <StatCard
          label="Assigned"
          value={String(data.summary.assigned)}
          icon={<NavIcon name="package" />}
          tint="neutral"
        />
        <StatCard
          label="Delivered"
          value={String(data.summary.delivered)}
          icon={<NavIcon name="inbox" />}
          tint="success"
        />
        <StatCard
          label="Remaining"
          value={String(data.summary.remaining)}
          icon={<NavIcon name="truck" />}
          tint="info"
        />
        <StatCard
          label="Failed"
          value={String(data.summary.failed)}
          icon={<NavIcon name="alert" />}
          tint="danger"
        />
      </div>

      {data.failedAttempts.length > 0 ? (
        <SectionCard title="Failed attempts — need action">
          <div className="flex flex-col gap-3">
            {data.failedAttempts.map((a) => (
              <div
                key={a.attemptId}
                className="rounded-lg border border-line bg-redbg px-3 py-3 transition-colors active:border-danger"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[14px] font-semibold text-ink">
                    {a.trackingId}
                  </span>
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
                  Next action: {a.nextAction.replaceAll("_", " ")} · {formatTime(a.attemptedAt)}
                </p>
                <Link
                  href={a.batchId ? `/rider/batches/${a.batchId}` : "/rider"}
                  className={`mt-3 ${riderPrimaryActionClass}`}
                >
                  Open batch →
                </Link>
              </div>
            ))}
          </div>
        </SectionCard>
      ) : null}

      {data.batches.length === 0 ? (
        <SectionCard title="Today's batches">
          <p className="text-[16px] font-semibold text-ink">No deliveries assigned today.</p>
          <p className="mt-1 text-[14px] text-slate2">
            Your dispatcher creates batches at the warehouse — a new batch will appear here as
            soon as it is assigned.
          </p>
        </SectionCard>
      ) : (
        data.batches.map((batch) => (
          <section
            key={batch.id}
            className="rounded-lg border border-line bg-surface p-5"
            aria-label={`Batch at ${batch.warehouseCode}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[16px] font-bold text-ink">
                {batch.warehouseCode}
              </span>
              <StatusBadge domain="generic" status={batch.status} />
              {batch.kind === "PICKUP" ? (
                <span className="rounded-full border border-line bg-cream px-2.5 py-1 text-[12px] font-semibold text-ink">
                  Pickup
                </span>
              ) : null}
              <span className="text-[14px] text-slate2">
                {batch.counts.completed}/{batch.counts.total} delivered
              </span>
              <Link
                href={`/rider/batches/${batch.id}`}
                className="ml-auto text-[14px] font-semibold text-brand"
              >
                Open batch →
              </Link>
            </div>
            <div className="mt-4 flex flex-col gap-3">
              {batch.jobs.length === 0 ? (
                <p className="text-[14px] text-slate2">No packages in this batch yet.</p>
              ) : (
                batch.jobs.map((job) => (
                  <JobCard key={job.assignmentId} job={job} canReportIncident={canReportIncident} />
                ))
              )}
            </div>
          </section>
        ))
      )}

      <SectionCard title="Cash on delivery">
        <dl className="flex flex-col divide-y divide-border text-[15px]">
          <div className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0">
            <dt className="text-slate2">Expected today</dt>
            <dd className="tnum font-semibold text-ink">
              {formatPaisa(BigInt(data.cod.expectedPaisa))}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0">
            <dt className="text-slate2">Collected</dt>
            <dd className="tnum font-semibold text-ink">
              {formatPaisa(BigInt(data.cod.collectedPaisa))}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0">
            <dt className="text-slate2">Still to collect</dt>
            <dd className="tnum font-semibold text-ink">
              {formatPaisa(BigInt(data.cod.remainingPaisa))}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0">
            <dt className="text-slate2">To hand over</dt>
            <dd className="tnum font-semibold text-ink">
              {formatPaisa(BigInt(data.cod.awaitingRemittancePaisa))}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0">
            <dt className="text-slate2">Handed over (verified)</dt>
            <dd className="tnum font-semibold text-ink">
              {formatPaisa(BigInt(data.cod.verifiedRemittedPaisa))}
            </dd>
          </div>
        </dl>
        <Link href="/rider/cod" className={`mt-4 ${riderSubtleActionClass}`}>
          View COD →
        </Link>
      </SectionCard>

      <div className="flex flex-wrap gap-2">
        {data.currentBatchId ? (
          <Link href={`/rider/batches/${data.currentBatchId}`} className={riderPrimaryActionClass}>
            Continue delivery
          </Link>
        ) : null}
        <Link href="/rider/reports" className={riderSubtleActionClass}>
          Delivery history &amp; reports
        </Link>
        {data.openTaskCount > 0 ? (
          <Link href="/rider/tasks" className={riderSubtleActionClass}>
            My tasks ({data.openTaskCount})
          </Link>
        ) : null}
      </div>

      {data.custody.length > 0 ? (
        <SectionCard title={`In your custody (${data.custody.length})`}>
          <ul className="flex flex-col gap-2">
            {data.custody.map((item) => (
              <li
                key={item.trackingId}
                className="flex min-h-[48px] flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2"
              >
                <span className="font-mono text-[14px] font-semibold text-ink">
                  {item.trackingId}
                </span>
                <StatusBadge domain="operational" status={item.packageStatus} />
                {item.warehouseCode ? (
                  <span className="font-mono text-[13px] text-slate2">{item.warehouseCode}</span>
                ) : null}
                <span className="text-[13px] text-slate2">since {formatTime(item.startedAt)}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {data.openTaskCount > 0 ? (
        <SectionCard title="My tasks">
          <ul className="flex flex-col">
            {data.tasks.map((task) => (
              <li key={task.id} className="border-b border-line last:border-0">
                <Link
                  href={`/rider/tasks/${task.id}`}
                  className="flex min-h-[48px] flex-wrap items-center gap-x-3 gap-y-1 py-2.5"
                >
                  <span className="min-w-0 flex-1 text-[15px] font-medium text-ink">
                    {task.title}
                  </span>
                  <PriorityBadge priority={task.priority} />
                  <StatusBadge domain="generic" status={task.status} />
                  <span
                    className={`shrink-0 text-[13px] ${
                      task.overdue ? "font-semibold text-danger" : "text-slate2"
                    }`}
                  >
                    {task.overdue
                      ? `Overdue${task.dueAt ? ` · due ${formatDateTime(task.dueAt)}` : ""}`
                      : task.dueAt
                        ? `Due ${formatDateTime(task.dueAt)}`
                        : "No due date"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {data.openTaskCount > data.tasks.length ? (
            <p className="mt-2 text-[13px] text-slate2">
              Showing the first {data.tasks.length} of {data.openTaskCount} open tasks — see My
              tasks for the rest.
            </p>
          ) : null}
        </SectionCard>
      ) : null}
    </div>
  );
}

export async function RiderFieldHome({ actor }: { actor: ActorContext }) {
  const today = new Date().toISOString().slice(0, 10);
  const data = await getRiderFieldHome(actor, today);
  const canReportIncident = hasPermission(actor, "incident.report");
  return <RiderFieldHomeView data={data} canReportIncident={canReportIncident} />;
}
