import type { ReactNode } from "react";
import Link from "next/link";

import type { FinanceConsoleData } from "@/server/services/finance-home";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ToneIcon } from "@/components/ui/ToneIcon";
import { EmptyState } from "@/components/ui/states";
import { NavIcon } from "@/components/layout/icons";
import type { NavIconName } from "@/lib/navigation/registry";
import { formatDateTime, formatPaisa } from "@/components/bookings/ui";
import { humaniseStatusValue } from "@/lib/status/labels";

/**
 * Finance home (V3 Step 8) — the finance dashboard rebuilt on the
 * Step 3 primitives and the Step 8 read model (`getFinanceConsole`).
 * Presentational only: the page resolves the actor and hands this
 * view the model (which carries the permission map as `can`).
 *
 * Hard rules honoured here:
 * - LINK-ONLY pending approvals: no approve/decide buttons and no
 *   forms anywhere in this view. Settlement approval sits with
 *   Admin / Super Admin by policy, and adjustment/refund decisions
 *   live on the adjustments queue page — this home only links to
 *   the queues (four-eyes is never weakened by a dashboard shortcut).
 * - Drill-throughs are BARE links: the finance module pages read no
 *   searchParams, so no card or row fakes a filter query.
 * - Money renders only through formatPaisa; statuses only through
 *   StatusBadge / humanised labels — never a raw enum, and never an
 *   account code containing ":" (per-owner codes embed UUIDs; the
 *   model already filters them and this view filters again as
 *   defence in depth — those accounts live on the ledger page).
 * - COD is a liability, never revenue: the three COD cards are
 *   labelled collected / awaiting remittance / still owed by riders,
 *   and the revenue card says it is ledger shipping revenue.
 */

const PRIMARY_LINK =
  "inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-[14px] font-[550] text-white hover:bg-primary-dark";
const SECONDARY_LINK =
  "inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-border-control bg-card px-4 py-2.5 text-[14px] font-[550] text-ink hover:bg-surface-2";

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** "2026-10-09" → "9 Oct" (the period range is a pair of ISO dates). */
function shortDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** "2026-10-09" → "9 Oct 2026" for the header's Kathmandu date. */
function longDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Age of a stored timestamp as compact real arithmetic ("12m",
 * "5h", "3d") — computed at render time on the server from the
 * stored instant, never a stored or invented figure.
 */
export function ageLabel(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor((now.getTime() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The model's honest four-eyes discriminator, in words. */
function awaitingLabel(
  awaiting: "AWAITING_ANOTHER_APPROVER" | "ACTIONABLE_BY_ACTOR" | "AWAITING_APPROVER",
): string {
  if (awaiting === "AWAITING_ANOTHER_APPROVER") return "Awaiting another approver (four-eyes)";
  if (awaiting === "ACTIONABLE_BY_ACTOR") return "Awaiting a decision";
  return "Awaiting an approver";
}

function QueueLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-[13px] font-semibold text-primary hover:text-primary-dark">
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Financial summary (DS §10 — the finance dashboard's summary block)
// ---------------------------------------------------------------------------

function FinancialSummary({ data }: { data: FinanceConsoleData }) {
  const { period, summary } = data;
  const periodWords = `Last 30 days ${shortDate(period.from)} – ${shortDate(period.to)}`;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label="Total invoiced"
          value={formatPaisa(period.invoiced.totalPaisa)}
          context={`${period.invoiced.count} invoice${period.invoiced.count === 1 ? "" : "s"} · ${periodWords}`}
          icon={<NavIcon name="file" />}
          tint="brand"
          href="/finance/invoices"
        />
        <StatCard
          label="Payments received"
          value={formatPaisa(period.paymentsReceived.totalPaisa)}
          context={`${period.paymentsReceived.count} payment${period.paymentsReceived.count === 1 ? "" : "s"} · ${periodWords}`}
          icon={<NavIcon name="hand" />}
          tint="success"
          href="/finance/reports"
        />
        <StatCard
          label="Shipping revenue"
          value={formatPaisa(summary.revenueLast30DaysPaisa)}
          context="Ledger shipping revenue — COD is never revenue"
          icon={<NavIcon name="chart" />}
          tint="info"
          href="/finance/reports"
        />
        <StatCard
          label="Outstanding"
          value={formatPaisa(summary.outstandingReceivablesPaisa)}
          context={`${summary.openInvoicesCount} open invoice${summary.openInvoicesCount === 1 ? "" : "s"}`}
          icon={<NavIcon name="inbox" />}
          tint="warning"
          href="/finance/invoices"
        />
        <StatCard
          label="COD collected"
          value={formatPaisa(summary.cod.collectedPaisa)}
          context="All time"
          icon={<NavIcon name="coins" />}
          tint="neutral"
          href="/finance/remittances"
        />
        <StatCard
          label="COD pending remittance"
          value={formatPaisa(summary.cod.awaitingRemittancePaisa)}
          context="Collected, not yet in a remittance"
          icon={<NavIcon name="truck" />}
          tint="warning"
          href="/finance/remittances"
        />
        <StatCard
          label="Rider balances"
          value={formatPaisa(summary.cod.outstandingPaisa)}
          context="Collected, not yet verified as remitted"
          icon={<NavIcon name="users" />}
          tint="warning"
          href="/finance/remittances"
        />
        <StatCard
          label="Vendor payables"
          value={formatPaisa(summary.vendorPayablePaisa)}
          context="Pending + approved-unpaid settlements"
          icon={<NavIcon name="store" />}
          tint="info"
          href="/finance/settlements"
        />
        <StatCard
          label="Refunds processed"
          value={formatPaisa(period.refunds.processedPaisa)}
          context={
            period.refunds.requestedOpen > 0
              ? `${period.refunds.processedCount} processed · ${period.refunds.requestedOpen} awaiting approval`
              : `${period.refunds.processedCount} processed · ${periodWords}`
          }
          icon={<NavIcon name="undo" />}
          tint="neutral"
          href="/finance/adjustments"
        />
      </div>

      {/* Today strip — inline stats, not cards. */}
      <div className="flex flex-wrap gap-x-8 gap-y-2 rounded-lg border border-border bg-card px-5 py-3">
        <p className="text-[13.5px] text-ink">
          <span className="font-semibold uppercase tracking-wide text-ink-2">Today · </span>
          Invoices issued:{" "}
          <span className="font-semibold tabular-nums">
            {data.operationsToday.invoicesIssued.count}
          </span>{" "}
          · {formatPaisa(data.operationsToday.invoicesIssued.totalPaisa)}
        </p>
        <p className="text-[13.5px] text-ink">
          Payments received:{" "}
          <span className="font-semibold tabular-nums">
            {data.operationsToday.paymentsReceived.count}
          </span>{" "}
          · {formatPaisa(data.operationsToday.paymentsReceived.totalPaisa)}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending approvals (link-only)
// ---------------------------------------------------------------------------

function PendingApprovals({ data }: { data: FinanceConsoleData }) {
  const { pending } = data;
  const nothingWaiting =
    pending.settlements.count === 0 &&
    pending.adjustments.count === 0 &&
    pending.refunds.count === 0 &&
    pending.remittances.count === 0 &&
    pending.remittanceDiscrepancies.count === 0;

  return (
    <Section title="Pending approvals">
      {nothingWaiting ? (
        <div className="flex items-center gap-3 rounded-lg bg-successbg px-4 py-3">
          <ToneIcon tone="success" className="h-[18px] w-[18px] text-success" />
          <p className="text-[13.5px] font-medium text-ink">
            Nothing is waiting on Finance right now.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {pending.settlements.count > 0 ? (
            <div>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[13.5px] font-semibold text-ink">
                  Settlements awaiting approval ({pending.settlements.count} ·{" "}
                  {formatPaisa(pending.settlements.netPayablePaisa)} net payable)
                </h3>
                <QueueLink href="/finance/settlements">Settlements queue →</QueueLink>
              </div>
              <p className="text-[12.5px] text-ink-2">
                Approval sits with Admin / Super Admin — Finance prepares and reviews.
              </p>
              <ul className="mt-1 divide-y divide-border">
                {pending.settlements.items.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center gap-2 py-2.5">
                    <span className="font-mono text-[12.5px] font-semibold text-ink">
                      {row.settlementNumber}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                      {row.vendorName ?? "Vendor"}
                    </span>
                    <span className="text-[13.5px] tabular-nums text-ink">
                      {formatPaisa(row.netPayablePaisa)}
                    </span>
                    <span className="text-[12.5px] tabular-nums text-ink-2">
                      {ageLabel(row.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {pending.adjustments.count > 0 ? (
            <div>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[13.5px] font-semibold text-ink">
                  Adjustments awaiting approval ({pending.adjustments.count})
                </h3>
                <QueueLink href="/finance/adjustments">Adjustments queue →</QueueLink>
              </div>
              <ul className="divide-y divide-border">
                {pending.adjustments.items.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center gap-2 py-2.5">
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                      {row.creatorName ?? "Finance user"} · {row.reason}
                    </span>
                    <span className="text-[13.5px] tabular-nums text-ink">
                      {formatPaisa(row.amountPaisa)}
                    </span>
                    <span className="text-[12.5px] text-ink-2">{awaitingLabel(row.awaiting)}</span>
                    <span className="text-[12.5px] tabular-nums text-ink-2">
                      {ageLabel(row.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {pending.refunds.count > 0 ? (
            <div>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[13.5px] font-semibold text-ink">
                  Refunds awaiting approval ({pending.refunds.count})
                </h3>
                <QueueLink href="/finance/adjustments">Refunds queue →</QueueLink>
              </div>
              <ul className="divide-y divide-border">
                {pending.refunds.items.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center gap-2 py-2.5">
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                      {row.requesterName ?? "Finance user"} · {row.reason}
                    </span>
                    <span className="text-[13.5px] tabular-nums text-ink">
                      {formatPaisa(row.amountPaisa)}
                    </span>
                    <span className="text-[12.5px] text-ink-2">{awaitingLabel(row.awaiting)}</span>
                    <span className="text-[12.5px] tabular-nums text-ink-2">
                      {ageLabel(row.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {pending.remittances.count > 0 ? (
            <div>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[13.5px] font-semibold text-ink">
                  COD remittances awaiting verification ({pending.remittances.count})
                </h3>
                <QueueLink href="/finance/remittances">Remittances queue →</QueueLink>
              </div>
              <ul className="divide-y divide-border">
                {pending.remittances.items.map((row) => (
                  <li key={row.id}>
                    <Link
                      href={`/finance/remittances/${row.id}`}
                      className="flex flex-wrap items-center gap-2 py-2.5 hover:bg-surface-2"
                    >
                      <span className="font-mono text-[12.5px] font-semibold text-primary">
                        {row.remittanceNumber}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                        {row.driverName ?? "Rider"}
                      </span>
                      <span className="text-[13.5px] tabular-nums text-ink">
                        {formatPaisa(row.declaredAmountPaisa)}
                      </span>
                      <StatusBadge domain="generic" status={row.status} density="compact" />
                      <span className="text-[12.5px] tabular-nums text-ink-2">
                        {ageLabel(row.submittedAt)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {pending.remittanceDiscrepancies.count > 0 ? (
            <div>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[13.5px] font-semibold text-ink">
                  Remittance discrepancies ({pending.remittanceDiscrepancies.count})
                </h3>
                <QueueLink href="/finance/remittances">Remittances queue →</QueueLink>
              </div>
              <ul className="divide-y divide-border">
                {pending.remittanceDiscrepancies.items.map((row) => (
                  <li key={row.id}>
                    <Link
                      href={`/finance/remittances/${row.id}`}
                      className="flex flex-wrap items-center gap-2 py-2.5 hover:bg-surface-2"
                    >
                      <ToneIcon tone="danger" className="h-[16px] w-[16px] shrink-0" />
                      <span className="font-mono text-[12.5px] font-semibold text-primary">
                        {row.remittanceNumber}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                        Declared {formatPaisa(row.declaredAmountPaisa)}
                        {row.discrepancyPaisa
                          ? ` · discrepancy ${formatPaisa(row.discrepancyPaisa)}`
                          : ""}
                      </span>
                      <span className="text-[12.5px] tabular-nums text-ink-2">
                        {ageLabel(row.submittedAt)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function FinanceHomeView({ data }: { data: FinanceConsoleData }) {
  const { can } = data;
  // Defence in depth for the audit's G4 leak: even if a per-owner
  // account ever reached this view, its UUID-bearing code never
  // renders here — it belongs on the ledger page only.
  const accounts = data.accounts.filter((account) => !account.code.includes(":"));

  const quickActions: { label: string; href: string; icon: NavIconName; show: boolean }[] = [
    // The generate-invoice form lives on the invoices page.
    { label: "Create invoice", href: "/finance/invoices", icon: "file", show: can.createInvoice },
    // Payments are recorded on the invoice detail page.
    { label: "Record payment", href: "/finance/invoices", icon: "wallet", show: can.recordPayment },
    { label: "View ledger", href: "/finance/ledger", icon: "sliders", show: can.viewLedger },
    { label: "COD remittances", href: "/finance/remittances", icon: "coins", show: can.codRemittances },
    // Vendor payables live on the settlements surface — one link, not two.
    { label: "Settlements", href: "/finance/settlements", icon: "store", show: can.settlements },
    { label: "Financial reports", href: "/finance/reports", icon: "chart", show: can.reports },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Finance"
        title="Finance dashboard"
        description={
          <>
            Kathmandu · {longDate(data.today)} · Last 30 days {shortDate(data.period.from)} –{" "}
            {shortDate(data.period.to)}
          </>
        }
        actions={
          <>
            {can.createInvoice ? (
              <Link href="/finance/invoices" className={PRIMARY_LINK}>
                Create invoice
              </Link>
            ) : null}
            {can.viewLedger ? (
              <Link href="/finance/ledger" className={SECONDARY_LINK}>
                View ledger
              </Link>
            ) : null}
          </>
        }
      />

      {/* Pending approvals lead the body (DS exception-first). */}
      <PendingApprovals data={data} />

      <FinancialSummary data={data} />

      {/* Recent invoices. */}
      <Section
        title="Recent Invoices"
        action={<QueueLink href="/finance/invoices">All invoices →</QueueLink>}
      >
        {data.recentInvoices.length === 0 ? (
          <p className="text-[13.5px] text-ink-2">No invoices yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  {["Number", "Vendor", "Status", "Issued"].map((header) => (
                    <th
                      key={header}
                      scope="col"
                      className="bg-surface-2 px-3 py-2 text-left text-[12px] font-semibold uppercase tracking-wide text-ink-2"
                    >
                      {header}
                    </th>
                  ))}
                  <th
                    scope="col"
                    className="bg-surface-2 px-3 py-2 text-right text-[12px] font-semibold uppercase tracking-wide text-ink-2"
                  >
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.recentInvoices.map((row) => (
                  <tr key={row.id} className="h-11 border-t border-border hover:bg-surface-2">
                    <td className="px-3 py-2 text-table">
                      <Link
                        href={`/finance/invoices/${row.id}`}
                        className="font-mono font-semibold whitespace-nowrap text-primary hover:text-primary-dark"
                      >
                        {row.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-table text-ink">{row.vendorName ?? "—"}</td>
                    <td className="px-3 py-2 text-table">
                      <StatusBadge domain="generic" status={row.status} density="compact" />
                    </td>
                    <td className="px-3 py-2 text-table whitespace-nowrap text-ink-2">
                      {formatDateTime(row.issuedAt)}
                    </td>
                    <td className="px-3 py-2 text-table text-right whitespace-nowrap tabular-nums text-ink">
                      {formatPaisa(row.totalPaisa)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Recent payments — a row drills to its invoice when it has
          one, otherwise to the ledger. */}
      <Section
        title="Recent Payments"
        action={<QueueLink href="/finance/ledger">Ledger →</QueueLink>}
      >
        {data.recentPayments.length === 0 ? (
          <p className="text-[13.5px] text-ink-2">No payments yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  {["Payer", "Method", "Status", "Date"].map((header) => (
                    <th
                      key={header}
                      scope="col"
                      className="bg-surface-2 px-3 py-2 text-left text-[12px] font-semibold uppercase tracking-wide text-ink-2"
                    >
                      {header}
                    </th>
                  ))}
                  <th
                    scope="col"
                    className="bg-surface-2 px-3 py-2 text-right text-[12px] font-semibold uppercase tracking-wide text-ink-2"
                  >
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.recentPayments.map((row) => (
                  <tr key={row.id} className="h-11 border-t border-border hover:bg-surface-2">
                    <td className="px-3 py-2 text-table">
                      <Link
                        href={row.invoiceId ? `/finance/invoices/${row.invoiceId}` : "/finance/ledger"}
                        className="font-semibold whitespace-nowrap text-primary hover:text-primary-dark"
                      >
                        {row.payerName ?? humaniseStatusValue(row.payerType)}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-table text-ink">
                      {humaniseStatusValue(row.method)}
                    </td>
                    <td className="px-3 py-2 text-table">
                      <StatusBadge domain="generic" status={row.status} density="compact" />
                    </td>
                    <td className="px-3 py-2 text-table whitespace-nowrap text-ink-2">
                      {formatDateTime(row.createdAt)}
                    </td>
                    <td className="px-3 py-2 text-table text-right whitespace-nowrap tabular-nums text-ink">
                      {formatPaisa(row.amountPaisa)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Accounts strip — system accounts only, friendly labels. */}
      {accounts.length > 0 ? (
        <Section
          title="Accounts"
          action={<QueueLink href="/finance/ledger">Ledger →</QueueLink>}
        >
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {accounts.map((account) => (
              <div key={account.id}>
                <dt className="text-[12.5px] font-semibold uppercase tracking-wide text-ink-2">
                  {account.label}
                </dt>
                <dd className="mt-1 text-[20px] font-semibold tabular-nums text-ink">
                  {formatPaisa(account.balancePaisa)}
                </dd>
                <dd className="text-[12.5px] text-ink-2">{humaniseStatusValue(account.kind)}</dd>
              </div>
            ))}
          </dl>
        </Section>
      ) : null}

      {/* Quick actions — permission-gated by the model's can map. */}
      <Section title="Quick Actions">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {quickActions
            .filter((a) => a.show)
            .map((a) => (
              <Link
                key={a.label}
                href={a.href}
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-[13.5px] font-medium text-ink hover:border-primary hover:bg-surface-2"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-light text-primary-dark">
                  <NavIcon name={a.icon} />
                </span>
                {a.label}
              </Link>
            ))}
        </div>
      </Section>

      {/* Kept for parity with the other homes' empty affordance:
          renders nothing today, but documents that a fully-empty
          console (no invoices, payments or accounts) still reads
          calmly rather than as an error. */}
      {data.recentInvoices.length === 0 &&
      data.recentPayments.length === 0 &&
      accounts.length === 0 ? (
        <EmptyState
          title="No finance activity yet"
          description="Invoices, payments and account balances appear here as soon as the first invoice is generated."
        />
      ) : null}
    </div>
  );
}
