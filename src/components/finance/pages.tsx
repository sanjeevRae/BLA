import Link from "next/link";

import { hasPermission, type ActorContext } from "@/lib/auth/actor";
import { formatDateTime, formatPaisa, StatusBadge } from "@/components/bookings/ui";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";
import { getFinanceOverview, listFinanceVendors, listLedgerEntries } from "@/server/services/finance-overview";
import { getFinanceHome } from "@/server/services/finance-home";
import { getInvoice, listInvoices } from "@/server/services/invoices";
import { getRemittance, getRiderCodPosition, listRemittances } from "@/server/services/cod-remittances";
import { getSettlement, getVendorStatement, listSettlements } from "@/server/services/settlements";
import { listAdjustments, listRefunds } from "@/server/services/finance-adjustments";
import {
  AdjustmentDecisionButtons,
  CreateAdjustmentForm,
  GenerateInvoiceForm,
  PrepareSettlementForm,
  RecordPaymentForm,
  RefundDecisionButtons,
  RequestRefundForm,
  ResolveRemittanceForm,
  SettlementActions,
  SubmitRemittanceForm,
  VerifyRemittanceForm,
  VoidInvoiceForm,
} from "@/components/finance/forms";

/**
 * Phase 7 finance screens. Every figure comes from the finance
 * services — balances summed from ledger entries, invoice paid
 * amounts from allocations/coverage/adjustments, settlement figures
 * from their itemised lines. Nothing is cached or hand-entered.
 */

function PageHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">{eyebrow}</div>
      <h1 className="mt-0.5 text-[22px] font-bold text-ink">{title}</h1>
    </div>
  );
}

function FinanceNav({ basePath }: { basePath: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Link href={`${basePath}/invoices`} className={subtleButtonClass}>
        Invoices →
      </Link>
      <Link href={`${basePath}/remittances`} className={subtleButtonClass}>
        COD remittances →
      </Link>
      <Link href={`${basePath}/settlements`} className={subtleButtonClass}>
        Settlements →
      </Link>
      <Link href={`${basePath}/ledger`} className={subtleButtonClass}>
        Ledger →
      </Link>
      <Link href={`${basePath}/adjustments`} className={subtleButtonClass}>
        Adjustments & refunds →
      </Link>
    </div>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-line bg-page px-4 py-3">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">{label}</dt>
      <dd className="tnum mt-1 text-[15px] font-semibold text-ink">{value}</dd>
      {sub ? <dd className="text-[12px] text-faint">{sub}</dd> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Finance home
// ---------------------------------------------------------------------------

export async function FinanceHomePage({ actor }: { actor: ActorContext }) {
  const home = await getFinanceHome(actor);
  const attention = home.attention;
  const nothingWaiting =
    attention.remittancesAwaitingVerification.count === 0 &&
    attention.remittancesInDiscrepancy.count === 0 &&
    attention.adjustmentsRequested.count === 0 &&
    attention.refundsRequested.count === 0 &&
    attention.settlementsAwaitingAdminApproval.count === 0;
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader eyebrow="Finance" title="Finance dashboard" />
        <FinanceNav basePath="/finance" />
      </div>

      <SectionCard title="Needs attention">
        {nothingWaiting ? (
          <p className="text-[13px] text-slate2">
            Nothing is waiting on Finance right now. New remittances, discrepancies and
            adjustment or refund requests appear here as they arrive.
          </p>
        ) : (
          <div className="grid gap-2">
            {attention.remittancesAwaitingVerification.items.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
              >
                <span className="text-ink">
                  Remittance {item.remittanceNumber} — {formatPaisa(item.declaredAmountPaisa)} declared,
                  awaiting verification
                </span>
                <Link href={`/finance/remittances/${item.id}`} className="font-semibold text-brand">
                  Verify →
                </Link>
              </div>
            ))}
            {attention.remittancesAwaitingVerification.count >
            attention.remittancesAwaitingVerification.items.length ? (
              <p className="text-[12px] text-slate2">
                {attention.remittancesAwaitingVerification.count} remittances awaiting verification in
                total — see the{" "}
                <Link href="/finance/remittances" className="font-semibold text-brand">
                  remittances queue
                </Link>
                .
              </p>
            ) : null}
            {attention.remittancesInDiscrepancy.items.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-redbg px-3 py-2 text-[13px]"
              >
                <span className="text-ink">
                  Remittance {item.remittanceNumber} — COD discrepancy
                  {item.discrepancyPaisa ? ` of ${formatPaisa(item.discrepancyPaisa)}` : ""}
                </span>
                <Link href={`/finance/remittances/${item.id}`} className="font-semibold text-brand">
                  Resolve →
                </Link>
              </div>
            ))}
            {attention.adjustmentsRequested.items.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
              >
                <span className="text-ink">
                  Adjustment — {item.targetType} · {formatPaisa(item.amountPaisa)} · {item.reason}
                  {item.awaiting === "AWAITING_ANOTHER_APPROVER" ? (
                    <span className="text-slate2">
                      {" "}
                      · you created this, so it awaits another approver (four-eyes)
                    </span>
                  ) : item.awaiting === "ACTIONABLE_BY_ACTOR" ? (
                    <span className="text-slate2"> · awaiting a decision</span>
                  ) : (
                    <span className="text-slate2"> · awaiting an approver</span>
                  )}
                </span>
                <Link href="/finance/adjustments" className="font-semibold text-brand">
                  Review →
                </Link>
              </div>
            ))}
            {attention.refundsRequested.items.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
              >
                <span className="text-ink">
                  Refund — {formatPaisa(item.amountPaisa)} · {item.reason}
                  {item.awaiting === "AWAITING_ANOTHER_APPROVER" ? (
                    <span className="text-slate2">
                      {" "}
                      · you requested this, so it awaits another approver (four-eyes)
                    </span>
                  ) : item.awaiting === "ACTIONABLE_BY_ACTOR" ? (
                    <span className="text-slate2"> · awaiting a decision</span>
                  ) : (
                    <span className="text-slate2"> · awaiting an approver</span>
                  )}
                </span>
                <Link href="/finance/adjustments" className="font-semibold text-brand">
                  Review →
                </Link>
              </div>
            ))}
            {attention.settlementsAwaitingAdminApproval.count > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                <span className="text-ink">
                  {attention.settlementsAwaitingAdminApproval.count} settlement(s) awaiting approval —{" "}
                  {formatPaisa(attention.settlementsAwaitingAdminApproval.netPayablePaisa)} net payable.
                  Approval sits with Admin / Super Admin, so this is read-only here.
                </span>
                <Link href="/finance/settlements" className="font-semibold text-brand">
                  View →
                </Link>
              </div>
            ) : null}
          </div>
        )}
      </SectionCard>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatTile
          label={`Revenue (${home.metrics.revenueRange.from} – ${home.metrics.revenueRange.to})`}
          value={formatPaisa(home.metrics.revenueLast30DaysPaisa)}
          sub="Shipping revenue from the ledger — COD is never revenue"
        />
        <StatTile
          label="Outstanding receivables"
          value={formatPaisa(home.metrics.outstandingReceivablesPaisa)}
          sub={`${home.metrics.openInvoicesCount} open invoices`}
        />
        <StatTile label="COD collected" value={formatPaisa(home.metrics.codCollectedPaisa)} />
        <StatTile
          label="COD held by riders"
          value={formatPaisa(home.metrics.codHeldByRidersPaisa)}
          sub="Collected, not yet verified as remitted"
        />
        <StatTile label="COD remitted (verified)" value={formatPaisa(home.metrics.codRemittedVerifiedPaisa)} />
        <StatTile
          label="Vendor payable"
          value={formatPaisa(home.metrics.vendorPayablePaisa)}
          sub="Pending + approved-unpaid settlements"
        />
      </dl>

      <SectionCard title="Current operations">
        <div className="grid gap-2 text-[13px]">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
            <span className="text-ink">
              Settlements queue — {home.operationsToday.settlementsPending.count} pending (
              {formatPaisa(home.operationsToday.settlementsPending.netPayablePaisa)} net),{" "}
              {home.operationsToday.settlementsApprovedUnpaid.count} approved and unpaid (
              {formatPaisa(home.operationsToday.settlementsApprovedUnpaid.netPayablePaisa)} net)
            </span>
            <Link href="/finance/settlements" className="font-semibold text-brand">
              Settlements →
            </Link>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
            <span className="text-ink">
              Invoices issued today — {home.operationsToday.invoicesIssued.count} ·{" "}
              {formatPaisa(home.operationsToday.invoicesIssued.totalPaisa)}
            </span>
            <Link href="/finance/invoices" className="font-semibold text-brand">
              Invoices →
            </Link>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
            <span className="text-ink">
              Payments today — {home.operationsToday.paymentsReceived.count} ·{" "}
              {formatPaisa(home.operationsToday.paymentsReceived.totalPaisa)}
            </span>
            <Link href="/finance/ledger" className="font-semibold text-brand">
              Ledger →
            </Link>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Recent activity">
        {home.recentLedger.length === 0 && home.recentPayments.length === 0 ? (
          <p className="text-[13px] text-slate2">No ledger entries or payments yet.</p>
        ) : (
          <div className="grid gap-4">
            {home.recentLedger.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="text-slate2">
                      <th className="py-1 pr-3 font-medium">Reference</th>
                      <th className="py-1 pr-3 font-medium">Account</th>
                      <th className="py-1 pr-3 font-medium">Type</th>
                      <th className="py-1 pr-3 font-medium">Debit</th>
                      <th className="py-1 pr-3 font-medium">Credit</th>
                      <th className="py-1 font-medium">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {home.recentLedger.map((entry) => (
                      <tr key={entry.id} className="border-t border-line">
                        <td className="py-1.5 pr-3 font-medium text-ink">{entry.reference}</td>
                        <td className="py-1.5 pr-3">{entry.accountCode}</td>
                        <td className="py-1.5 pr-3">{entry.type}</td>
                        <td className="tnum py-1.5 pr-3">
                          {entry.direction === "DEBIT" ? formatPaisa(entry.amountPaisa) : "—"}
                        </td>
                        <td className="tnum py-1.5 pr-3">
                          {entry.direction === "CREDIT" ? formatPaisa(entry.amountPaisa) : "—"}
                        </td>
                        <td className="py-1.5">{formatDateTime(entry.occurredAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {home.recentPayments.length > 0 ? (
              <div className="grid gap-2">
                {home.recentPayments.map((payment) => (
                  <div
                    key={payment.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
                  >
                    <span className="text-ink">
                      Payment {formatPaisa(payment.amountPaisa)} · {payment.method} ·{" "}
                      {formatDateTime(payment.createdAt)}
                    </span>
                    <StatusBadge status={payment.status} />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Quick actions">
        <div className="flex flex-wrap gap-2">
          <Link href="/finance/invoices" className={subtleButtonClass}>
            Generate invoice →
          </Link>
          <Link href="/finance/remittances" className={subtleButtonClass}>
            Verify a remittance →
          </Link>
          <Link href="/finance/adjustments" className={subtleButtonClass}>
            Adjustments & refunds →
          </Link>
          <Link href="/finance/tasks" className={subtleButtonClass}>
            Tasks →
          </Link>
          <Link href="/finance/reports" className={subtleButtonClass}>
            Financial reports →
          </Link>
        </div>
      </SectionCard>

      <SectionCard title="Account balances (derived from the ledger)">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="text-slate2">
                <th className="py-1 pr-3 font-medium">Account</th>
                <th className="py-1 pr-3 font-medium">Kind</th>
                <th className="py-1 pr-3 font-medium">Owner</th>
                <th className="py-1 font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              {home.accounts.map((account) => (
                <tr key={account.id} className="border-t border-line">
                  <td className="py-1.5 pr-3 font-medium text-ink">{account.code}</td>
                  <td className="py-1.5 pr-3">{account.kind}</td>
                  <td className="py-1.5 pr-3">{account.ownerType}</td>
                  <td className="tnum py-1.5">{formatPaisa(account.balancePaisa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export async function InvoicesListPage({
  actor,
  basePath,
  detailBase,
}: {
  actor: ActorContext;
  basePath: string;
  detailBase: string;
}) {
  const [{ items, meta }, vendors] = await Promise.all([
    listInvoices(actor, { pageSize: 100 }),
    hasPermission(actor, "invoice.create") ? listFinanceVendors(actor) : Promise.resolve([]),
  ]);
  const canCreate = hasPermission(actor, "invoice.create");
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader eyebrow="Finance" title={`Invoices (${meta.total})`} />
        <FinanceNav basePath={basePath} />
      </div>
      {canCreate ? (
        <SectionCard title="Generate vendor invoice">
          <GenerateInvoiceForm vendors={vendors} />
        </SectionCard>
      ) : null}
      <SectionCard title="Invoices">
        {items.length === 0 ? (
          <p className="text-[13px] text-slate2">No invoices yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="text-slate2">
                  <th className="py-1 pr-3 font-medium">Number</th>
                  <th className="py-1 pr-3 font-medium">Vendor</th>
                  <th className="py-1 pr-3 font-medium">Total</th>
                  <th className="py-1 pr-3 font-medium">Paid</th>
                  <th className="py-1 pr-3 font-medium">Outstanding</th>
                  <th className="py-1 pr-3 font-medium">Status</th>
                  <th className="py-1 font-medium">Issued</th>
                </tr>
              </thead>
              <tbody>
                {items.map((invoice) => (
                  <tr key={invoice.id} className="border-t border-line">
                    <td className="py-1.5 pr-3">
                      <Link href={`${detailBase}/${invoice.id}`} className="font-semibold text-brand">
                        {invoice.invoiceNumber}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-3">{invoice.vendorName ?? "—"}</td>
                    <td className="tnum py-1.5 pr-3">{formatPaisa(invoice.totalPaisa)}</td>
                    <td className="tnum py-1.5 pr-3">{formatPaisa(invoice.paidPaisa)}</td>
                    <td className="tnum py-1.5 pr-3">{formatPaisa(invoice.outstandingPaisa)}</td>
                    <td className="py-1.5 pr-3">
                      <StatusBadge status={invoice.status} />
                    </td>
                    <td className="py-1.5">{formatDateTime(invoice.issuedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

export async function InvoiceDetailPage({
  actor,
  invoiceId,
  backHref,
}: {
  actor: ActorContext;
  invoiceId: string;
  backHref: string;
}) {
  const invoice = await getInvoice(actor, invoiceId);
  const canPay = hasPermission(actor, "finance.record_payment");
  const canVoid = hasPermission(actor, "invoice.create");
  const canRefund = hasPermission(actor, "refund.process");
  const open = invoice.status !== "PAID" && invoice.status !== "CANCELLED" && invoice.status !== "REFUNDED";
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader eyebrow={`Invoice · ${invoice.vendorName ?? "Counter"}`} title={invoice.invoiceNumber} />
        <Link href={backHref} className={subtleButtonClass}>
          ← All invoices
        </Link>
      </div>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total" value={formatPaisa(invoice.totalPaisa)} />
        <StatTile label="Paid" value={formatPaisa(invoice.paidPaisa)} sub={`settlements ${formatPaisa(invoice.settlementCoveragePaisa)} · credits ${formatPaisa(invoice.adjustmentCreditsPaisa)}`} />
        <StatTile label="Outstanding" value={formatPaisa(invoice.outstandingPaisa)} sub={invoice.reservedPaisa !== "0" ? `${formatPaisa(invoice.reservedPaisa)} reserved by an approved settlement` : undefined} />
        <StatTile label="Status" value={invoice.status} sub={invoice.dueAt ? `due ${formatDateTime(invoice.dueAt)}` : undefined} />
      </dl>
      <SectionCard title="Lines">
        <div className="grid gap-2">
          {invoice.lines.map((line) => (
            <div key={line.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
              <span className="text-ink">{line.description}</span>
              <span className="flex items-center gap-2">
                <StatusBadge status={line.kind} />
                <span className="tnum font-medium">{formatPaisa(line.amountPaisa)}</span>
              </span>
            </div>
          ))}
        </div>
      </SectionCard>
      <SectionCard title="Payments allocated">
        {invoice.payments.length === 0 ? (
          <p className="text-[13px] text-slate2">No payments allocated yet.</p>
        ) : (
          <div className="grid gap-2">
            {invoice.payments.map((payment) => (
              <div key={payment.paymentId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                <span className="text-ink">
                  {formatPaisa(payment.amountPaisa)} · {payment.method}
                  {payment.transactionRef ? ` · ref ${payment.transactionRef}` : ""}
                  {payment.paidAt ? ` · ${formatDateTime(payment.paidAt)}` : ""}
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={payment.status} />
                  {canRefund && payment.status === "PAID" ? <RequestRefundForm paymentId={payment.paymentId} /> : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
      {canPay && open ? (
        <SectionCard title="Record payment">
          <RecordPaymentForm invoiceId={invoice.id} outstandingPaisa={invoice.outstandingPaisa} />
        </SectionCard>
      ) : null}
      {canVoid && invoice.status === "ISSUED" ? (
        <SectionCard title="Void">
          <VoidInvoiceForm invoiceId={invoice.id} />
        </SectionCard>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Remittances
// ---------------------------------------------------------------------------

export async function RemittancesListPage({
  actor,
  basePath,
  detailBase,
}: {
  actor: ActorContext;
  basePath: string;
  detailBase: string;
}) {
  const { items, meta } = await listRemittances(actor, { pageSize: 100 });
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader eyebrow="Finance" title={`COD remittances (${meta.total})`} />
        <FinanceNav basePath={basePath} />
      </div>
      <SectionCard title="Remittances">
        {items.length === 0 ? (
          <p className="text-[13px] text-slate2">No remittances yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="text-slate2">
                  <th className="py-1 pr-3 font-medium">Number</th>
                  <th className="py-1 pr-3 font-medium">Rider</th>
                  <th className="py-1 pr-3 font-medium">Declared</th>
                  <th className="py-1 pr-3 font-medium">Counted</th>
                  <th className="py-1 pr-3 font-medium">Discrepancy</th>
                  <th className="py-1 pr-3 font-medium">Status</th>
                  <th className="py-1 font-medium">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {items.map((remittance) => (
                  <tr key={remittance.id} className="border-t border-line">
                    <td className="py-1.5 pr-3">
                      <Link href={`${detailBase}/${remittance.id}`} className="font-semibold text-brand">
                        {remittance.remittanceNumber}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-3">{remittance.driverName ?? "—"}</td>
                    <td className="tnum py-1.5 pr-3">{formatPaisa(remittance.declaredAmountPaisa)}</td>
                    <td className="tnum py-1.5 pr-3">{remittance.countedAmountPaisa ? formatPaisa(remittance.countedAmountPaisa) : "—"}</td>
                    <td className="tnum py-1.5 pr-3">{remittance.discrepancyPaisa ? formatPaisa(remittance.discrepancyPaisa) : "—"}</td>
                    <td className="py-1.5 pr-3">
                      <StatusBadge status={remittance.resolution ?? remittance.status} />
                    </td>
                    <td className="py-1.5">{formatDateTime(remittance.submittedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

export async function RemittanceDetailPage({
  actor,
  remittanceId,
  backHref,
}: {
  actor: ActorContext;
  remittanceId: string;
  backHref: string;
}) {
  const remittance = await getRemittance(actor, remittanceId);
  const canVerify = hasPermission(actor, "cod.verify");
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader eyebrow={`Remittance · ${remittance.driverName ?? ""}`} title={remittance.remittanceNumber} />
        <Link href={backHref} className={subtleButtonClass}>
          ← All remittances
        </Link>
      </div>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Declared by rider" value={formatPaisa(remittance.declaredAmountPaisa)} />
        <StatTile label="Collections total" value={formatPaisa(remittance.collectedPaisa)} sub={`expected ${formatPaisa(remittance.expectedPaisa)}`} />
        <StatTile label="Counted" value={remittance.countedAmountPaisa ? formatPaisa(remittance.countedAmountPaisa) : "—"} />
        <StatTile label="Status" value={remittance.resolution ?? remittance.status} sub={remittance.discrepancyPaisa ? `discrepancy ${formatPaisa(remittance.discrepancyPaisa)}` : undefined} />
      </dl>
      <SectionCard title="Collections">
        <div className="grid gap-2">
          {remittance.lines.map((line) => (
            <div key={line.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
              <span className="text-ink">Package {line.packageId.slice(0, 8)}… · {line.collectionStatus}</span>
              <span className="tnum">
                collected {formatPaisa(line.collectedPaisa)} of {formatPaisa(line.expectedPaisa)}
                {line.verifiedPaisa !== null ? ` · verified ${formatPaisa(line.verifiedPaisa)}` : ""}
              </span>
            </div>
          ))}
          {remittance.lines.length === 0 ? (
            <p className="text-[13px] text-slate2">Lines were released when this remittance was rejected.</p>
          ) : null}
        </div>
      </SectionCard>
      {canVerify && (remittance.status === "SUBMITTED" || remittance.status === "UNDER_VERIFICATION") ? (
        <SectionCard title="Verify the handover">
          <VerifyRemittanceForm
            remittanceId={remittance.id}
            declaredPaisa={remittance.declaredAmountPaisa}
            collectedPaisa={remittance.collectedPaisa}
          />
        </SectionCard>
      ) : null}
      {canVerify && remittance.status === "DISCREPANCY" ? (
        <SectionCard title="Resolve the discrepancy">
          <ResolveRemittanceForm remittanceId={remittance.id} />
        </SectionCard>
      ) : null}
      {remittance.resolutionNote ? (
        <SectionCard title="Resolution">
          <p className="text-[13px] text-ink">{remittance.resolutionNote}</p>
        </SectionCard>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

export async function SettlementsListPage({
  actor,
  basePath,
  detailBase,
}: {
  actor: ActorContext;
  basePath: string;
  detailBase: string;
}) {
  const [{ items, meta }, vendors] = await Promise.all([
    listSettlements(actor, { pageSize: 100 }),
    hasPermission(actor, "settlement.prepare") ? listFinanceVendors(actor) : Promise.resolve([]),
  ]);
  const canPrepare = hasPermission(actor, "settlement.prepare");
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader eyebrow="Settlements" title={`Vendor settlements (${meta.total})`} />
        {basePath === "/finance" ? <FinanceNav basePath={basePath} /> : null}
      </div>
      {canPrepare ? (
        <SectionCard title="Prepare settlement">
          <PrepareSettlementForm vendors={vendors} />
        </SectionCard>
      ) : null}
      <SectionCard title="Settlements">
        {items.length === 0 ? (
          <p className="text-[13px] text-slate2">No settlements yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="text-slate2">
                  <th className="py-1 pr-3 font-medium">Number</th>
                  <th className="py-1 pr-3 font-medium">Vendor</th>
                  <th className="py-1 pr-3 font-medium">COD</th>
                  <th className="py-1 pr-3 font-medium">Charges</th>
                  <th className="py-1 pr-3 font-medium">Deductions</th>
                  <th className="py-1 pr-3 font-medium">Net payable</th>
                  <th className="py-1 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((settlement) => (
                  <tr key={settlement.id} className="border-t border-line">
                    <td className="py-1.5 pr-3">
                      <Link href={`${detailBase}/${settlement.id}`} className="font-semibold text-brand">
                        {settlement.settlementNumber}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-3">{settlement.vendorName ?? "—"}</td>
                    <td className="tnum py-1.5 pr-3">{formatPaisa(settlement.grossCodPaisa)}</td>
                    <td className="tnum py-1.5 pr-3">{formatPaisa(settlement.shippingChargesPaisa)}</td>
                    <td className="tnum py-1.5 pr-3">{formatPaisa(settlement.otherDeductionsPaisa)}</td>
                    <td className="tnum py-1.5 pr-3 font-medium">{formatPaisa(settlement.netPayablePaisa)}</td>
                    <td className="py-1.5">
                      <StatusBadge status={settlement.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

export async function SettlementDetailPage({
  actor,
  settlementId,
  basePath,
}: {
  actor: ActorContext;
  settlementId: string;
  basePath: string;
}) {
  const settlement = await getSettlement(actor, settlementId);
  const canApprove = hasPermission(actor, "settlement.approve");
  const canPay = hasPermission(actor, "settlement.pay");
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader eyebrow={`Settlement · ${settlement.vendorName ?? ""}`} title={settlement.settlementNumber} />
        <Link href={basePath} className={subtleButtonClass}>
          ← All settlements
        </Link>
      </div>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Verified COD" value={formatPaisa(settlement.grossCodPaisa)} />
        <StatTile label="Shipping charges" value={formatPaisa(settlement.shippingChargesPaisa)} />
        <StatTile label="Deductions" value={formatPaisa(settlement.otherDeductionsPaisa)} />
        <StatTile label="Net payable" value={formatPaisa(settlement.netPayablePaisa)} sub={settlement.status} />
      </dl>
      <SectionCard title="Itemised lines">
        <div className="grid gap-2">
          {settlement.lines.map((line) => (
            <div key={line.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
              <span className="text-ink">
                {line.description ?? line.kind}
                {line.invoiceNumber ? ` · ${line.invoiceNumber}` : ""}
              </span>
              <span className="flex items-center gap-2">
                <StatusBadge status={line.kind} />
                <span className="tnum font-medium">{formatPaisa(line.amountPaisa)}</span>
              </span>
            </div>
          ))}
        </div>
      </SectionCard>
      {settlement.status === "PENDING" || settlement.status === "APPROVED" ? (
        <SectionCard title="Actions">
          <SettlementActions
            settlementId={settlement.id}
            status={settlement.status}
            canApprove={canApprove}
            canPay={canPay}
            basePath={basePath}
          />
        </SectionCard>
      ) : null}
      {settlement.paymentRef ? (
        <p className="text-[13px] text-slate2">Payout reference: {settlement.paymentRef}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export async function LedgerPage({ actor }: { actor: ActorContext }) {
  const [{ items, meta }, overview] = await Promise.all([
    listLedgerEntries(actor, { pageSize: 100 }),
    getFinanceOverview(actor),
  ]);
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader eyebrow="Finance" title="Ledger (read-only)" />
        <FinanceNav basePath="/finance" />
      </div>
      <SectionCard title="Account balances">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {overview.accounts.map((account) => (
            <div key={account.id} className="rounded-md border border-line px-3 py-2 text-[13px]">
              <div className="font-medium text-ink">{account.code}</div>
              <div className="tnum text-slate2">
                {account.kind} · {formatPaisa(account.balancePaisa)}
              </div>
            </div>
          ))}
        </div>
      </SectionCard>
      <SectionCard title={`Journal entries (${meta.total})`}>
        <p className="mb-3 text-[12px] text-faint">
          Entries are append-only: corrections appear as new REVERSAL / ADJUSTMENT entries linked to the
          originals. Entries sharing a journal reference form one balanced journal.
        </p>
        {items.length === 0 ? (
          <p className="text-[13px] text-slate2">No ledger entries yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="text-slate2">
                  <th className="py-1 pr-3 font-medium">Reference</th>
                  <th className="py-1 pr-3 font-medium">Journal</th>
                  <th className="py-1 pr-3 font-medium">Account</th>
                  <th className="py-1 pr-3 font-medium">Type</th>
                  <th className="py-1 pr-3 font-medium">Debit</th>
                  <th className="py-1 pr-3 font-medium">Credit</th>
                  <th className="py-1 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {items.map((entry) => (
                  <tr key={entry.id} className="border-t border-line">
                    <td className="py-1.5 pr-3 font-medium text-ink">{entry.reference}</td>
                    <td className="py-1.5 pr-3">{entry.journalRef}</td>
                    <td className="py-1.5 pr-3">{entry.accountCode}</td>
                    <td className="py-1.5 pr-3">{entry.type}</td>
                    <td className="tnum py-1.5 pr-3">{entry.direction === "DEBIT" ? formatPaisa(entry.amountPaisa) : "—"}</td>
                    <td className="tnum py-1.5 pr-3">{entry.direction === "CREDIT" ? formatPaisa(entry.amountPaisa) : "—"}</td>
                    <td className="py-1.5">{formatDateTime(entry.occurredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Adjustments + refunds
// ---------------------------------------------------------------------------

export async function AdjustmentsPage({
  actor,
  navBase,
}: {
  actor: ActorContext;
  navBase?: string;
}) {
  const [adjustments, refunds] = await Promise.all([
    listAdjustments(actor, { pageSize: 100 }),
    listRefunds(actor, { pageSize: 100 }),
  ]);
  const canCreate = hasPermission(actor, "finance.adjust");
  const canDecideAdjustments = hasPermission(actor, "finance.approve_adjustment");
  const canProcessRefunds = hasPermission(actor, "refund.process");
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader eyebrow="Finance" title="Adjustments & refunds" />
        {navBase ? <FinanceNav basePath={navBase} /> : null}
      </div>
      {canCreate ? (
        <SectionCard title="New adjustment">
          <CreateAdjustmentForm />
        </SectionCard>
      ) : null}
      <SectionCard title={`Adjustments (${adjustments.meta.total})`}>
        {adjustments.items.length === 0 ? (
          <p className="text-[13px] text-slate2">No adjustments yet.</p>
        ) : (
          <div className="grid gap-2">
            {adjustments.items.map((adjustment) => (
              <div key={adjustment.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                <span className="text-ink">
                  {adjustment.targetType} · {formatPaisa(adjustment.amountPaisa)} · {adjustment.reason}
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={adjustment.status} />
                  {canDecideAdjustments ? (
                    <AdjustmentDecisionButtons adjustmentId={adjustment.id} status={adjustment.status} />
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
      <SectionCard title={`Refunds (${refunds.meta.total})`}>
        {refunds.items.length === 0 ? (
          <p className="text-[13px] text-slate2">No refunds yet.</p>
        ) : (
          <div className="grid gap-2">
            {refunds.items.map((refund) => (
              <div key={refund.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                <span className="text-ink">
                  {formatPaisa(refund.amountPaisa)} · {refund.reason}
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={refund.status} />
                  {canProcessRefunds ? <RefundDecisionButtons refundId={refund.id} status={refund.status} /> : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vendor billing + rider COD
// ---------------------------------------------------------------------------

export async function VendorBillingPage({ actor }: { actor: ActorContext }) {
  if (!actor.vendorId) {
    return (
      <div className="grid gap-5">
        <PageHeader eyebrow="Billing" title="Billing" />
        <p className="text-[13px] text-ink">Your account is not linked to a vendor organisation yet.</p>
      </div>
    );
  }
  const [statement, invoices, settlements] = await Promise.all([
    getVendorStatement(actor, actor.vendorId),
    listInvoices(actor, { pageSize: 50 }),
    listSettlements(actor, { pageSize: 50 }),
  ]);
  return (
    <div className="grid gap-5">
      <PageHeader eyebrow="Billing" title={statement.vendorName} />
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile label="Payable balance" value={formatPaisa(statement.payableBalancePaisa)} sub="COD held minus charges, from the ledger" />
        <StatTile label="Open invoices" value={formatPaisa(statement.openInvoicesPaisa)} />
        <StatTile label="Verified COD awaiting settlement" value={formatPaisa(statement.unsettledVerifiedCodPaisa)} />
      </dl>
      <SectionCard title="Your invoices">
        {invoices.items.length === 0 ? (
          <p className="text-[13px] text-slate2">No invoices yet.</p>
        ) : (
          <div className="grid gap-2">
            {invoices.items.map((invoice) => (
              <div key={invoice.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                <Link href={`/vendor/billing/invoices/${invoice.id}`} className="font-semibold text-brand">
                  {invoice.invoiceNumber}
                </Link>
                <span className="tnum text-ink">
                  {formatPaisa(invoice.totalPaisa)} · outstanding {formatPaisa(invoice.outstandingPaisa)}
                </span>
                <StatusBadge status={invoice.status} />
              </div>
            ))}
          </div>
        )}
      </SectionCard>
      <SectionCard title="Your settlements">
        {settlements.items.length === 0 ? (
          <p className="text-[13px] text-slate2">No settlements yet.</p>
        ) : (
          <div className="grid gap-2">
            {settlements.items.map((settlement) => (
              <div key={settlement.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                <Link href={`/vendor/billing/settlements/${settlement.id}`} className="font-semibold text-brand">
                  {settlement.settlementNumber}
                </Link>
                <span className="tnum text-ink">net {formatPaisa(settlement.netPayablePaisa)}</span>
                <StatusBadge status={settlement.status} />
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

export async function RiderCodPage({ actor }: { actor: ActorContext }) {
  if (!actor.driverId) {
    return (
      <div className="grid gap-5">
        <PageHeader eyebrow="COD" title="COD obligations" />
        <p className="text-[13px] text-ink">Your account is not linked to a rider profile yet.</p>
      </div>
    );
  }
  const [position, remittances] = await Promise.all([
    getRiderCodPosition(actor),
    listRemittances(actor, { pageSize: 50 }),
  ]);
  return (
    <div className="grid gap-5">
      <PageHeader eyebrow="COD" title="Your COD obligations" />
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Collected, not yet remitted" value={formatPaisa(position.awaitingRemittanceTotalPaisa)} />
        <StatTile label="In open remittances" value={formatPaisa(position.inOpenRemittancePaisa)} />
        <StatTile label="Verified remitted" value={formatPaisa(position.verifiedRemittedPaisa)} />
        <StatTile label="Still owed (ledger)" value={formatPaisa(position.ledgerOwedPaisa)} />
      </dl>
      <SectionCard title="Hand over COD">
        <SubmitRemittanceForm collections={position.awaitingRemittance} />
      </SectionCard>
      <SectionCard title="Your remittances">
        {remittances.items.length === 0 ? (
          <p className="text-[13px] text-slate2">No remittances yet.</p>
        ) : (
          <div className="grid gap-2">
            {remittances.items.map((remittance) => (
              <div key={remittance.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                <span className="font-medium text-ink">{remittance.remittanceNumber}</span>
                <span className="tnum text-ink">
                  declared {formatPaisa(remittance.declaredAmountPaisa)}
                  {remittance.countedAmountPaisa ? ` · counted ${formatPaisa(remittance.countedAmountPaisa)}` : ""}
                </span>
                <StatusBadge status={remittance.resolution ?? remittance.status} />
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
