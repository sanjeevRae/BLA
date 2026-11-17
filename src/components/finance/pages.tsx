import Link from "next/link";

import { hasPermission, type ActorContext } from "@/lib/auth/actor";
import { formatDateTime, formatPaisa, StatusBadge } from "@/components/bookings/ui";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";
import { PageHeader } from "@/components/ui/PageHeader";
import { DensityScope } from "@/components/ui/TableDensity";
import {
  TABLE_CLASS,
  TD_CLASS,
  TD_ID_CLASS,
  TD_NUMERIC_CLASS,
  THEAD_ROW_CLASS,
  TH_CLASS,
  TH_NUMERIC_CLASS,
  TR_CLASS,
} from "@/components/ui/table-chrome";
import { getFinanceOverview, listFinanceVendors, listLedgerEntries } from "@/server/services/finance-overview";
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
    <div className="rounded-md border border-border bg-page px-4 py-3">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-2">{label}</dt>
      <dd className="tnum mt-1 text-[15px] font-semibold text-ink">{value}</dd>
      {sub ? <dd className="text-[12px] text-ink-2">{sub}</dd> : null}
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
      <PageHeader
        eyebrow="Finance"
        title={`Invoices (${meta.total})`}
        actions={<FinanceNav basePath={basePath} />}
      />
      {canCreate ? (
        <SectionCard title="Generate vendor invoice">
          <GenerateInvoiceForm vendors={vendors} />
        </SectionCard>
      ) : null}
      <SectionCard title="Invoices">
        {items.length === 0 ? (
          <p className="text-[13px] text-ink-2">No invoices yet.</p>
        ) : (
          <DensityScope showToggle>
            <div className="overflow-x-auto">
              <table className={TABLE_CLASS}>
                <thead>
                  <tr className={THEAD_ROW_CLASS}>
                    <th className={`${TH_CLASS} text-left`}>Number</th>
                    <th className={`${TH_CLASS} text-left`}>Vendor</th>
                    <th className={TH_NUMERIC_CLASS}>Total</th>
                    <th className={TH_NUMERIC_CLASS}>Paid</th>
                    <th className={TH_NUMERIC_CLASS}>Outstanding</th>
                    <th className={`${TH_CLASS} text-left`}>Status</th>
                    <th className={`${TH_CLASS} text-left`}>Issued</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((invoice) => (
                    <tr key={invoice.id} className={TR_CLASS}>
                      <td className={TD_ID_CLASS}>
                        <Link href={`${detailBase}/${invoice.id}`} className="font-semibold text-primary">
                          {invoice.invoiceNumber}
                        </Link>
                      </td>
                      <td className={TD_CLASS}>{invoice.vendorName ?? "—"}</td>
                      <td className={TD_NUMERIC_CLASS}>{formatPaisa(invoice.totalPaisa)}</td>
                      <td className={TD_NUMERIC_CLASS}>{formatPaisa(invoice.paidPaisa)}</td>
                      <td className={TD_NUMERIC_CLASS}>{formatPaisa(invoice.outstandingPaisa)}</td>
                      <td className={TD_CLASS}>
                        <StatusBadge status={invoice.status} />
                      </td>
                      <td className={TD_CLASS}>{formatDateTime(invoice.issuedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </DensityScope>
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
            <div key={line.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-[13px]">
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
          <p className="text-[13px] text-ink-2">No payments allocated yet.</p>
        ) : (
          <div className="grid gap-2">
            {invoice.payments.map((payment) => (
              <div key={payment.paymentId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-[13px]">
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
      <PageHeader
        eyebrow="Finance"
        title={`COD remittances (${meta.total})`}
        actions={<FinanceNav basePath={basePath} />}
      />
      <SectionCard title="Remittances">
        {items.length === 0 ? (
          <p className="text-[13px] text-ink-2">No remittances yet.</p>
        ) : (
          <DensityScope showToggle>
            <div className="overflow-x-auto">
              <table className={TABLE_CLASS}>
                <thead>
                  <tr className={THEAD_ROW_CLASS}>
                    <th className={`${TH_CLASS} text-left`}>Number</th>
                    <th className={`${TH_CLASS} text-left`}>Rider</th>
                    <th className={TH_NUMERIC_CLASS}>Declared</th>
                    <th className={TH_NUMERIC_CLASS}>Counted</th>
                    <th className={TH_NUMERIC_CLASS}>Discrepancy</th>
                    <th className={`${TH_CLASS} text-left`}>Status</th>
                    <th className={`${TH_CLASS} text-left`}>Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((remittance) => (
                    <tr key={remittance.id} className={TR_CLASS}>
                      <td className={TD_ID_CLASS}>
                        <Link href={`${detailBase}/${remittance.id}`} className="font-semibold text-primary">
                          {remittance.remittanceNumber}
                        </Link>
                      </td>
                      <td className={TD_CLASS}>{remittance.driverName ?? "—"}</td>
                      <td className={TD_NUMERIC_CLASS}>{formatPaisa(remittance.declaredAmountPaisa)}</td>
                      <td className={TD_NUMERIC_CLASS}>{remittance.countedAmountPaisa ? formatPaisa(remittance.countedAmountPaisa) : "—"}</td>
                      <td className={TD_NUMERIC_CLASS}>{remittance.discrepancyPaisa ? formatPaisa(remittance.discrepancyPaisa) : "—"}</td>
                      <td className={TD_CLASS}>
                        <StatusBadge status={remittance.resolution ?? remittance.status} />
                      </td>
                      <td className={TD_CLASS}>{formatDateTime(remittance.submittedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </DensityScope>
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
            <div key={line.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-[13px]">
              <span className="text-ink">Package {line.packageId.slice(0, 8)}… · {line.collectionStatus}</span>
              <span className="tnum">
                collected {formatPaisa(line.collectedPaisa)} of {formatPaisa(line.expectedPaisa)}
                {line.verifiedPaisa !== null ? ` · verified ${formatPaisa(line.verifiedPaisa)}` : ""}
              </span>
            </div>
          ))}
          {remittance.lines.length === 0 ? (
            <p className="text-[13px] text-ink-2">Lines were released when this remittance was rejected.</p>
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
      <PageHeader
        eyebrow="Settlements"
        title={`Vendor settlements (${meta.total})`}
        actions={basePath === "/finance" ? <FinanceNav basePath={basePath} /> : undefined}
      />
      {canPrepare ? (
        <SectionCard title="Prepare settlement">
          <PrepareSettlementForm vendors={vendors} />
        </SectionCard>
      ) : null}
      <SectionCard title="Settlements">
        {items.length === 0 ? (
          <p className="text-[13px] text-ink-2">No settlements yet.</p>
        ) : (
          <DensityScope showToggle>
            <div className="overflow-x-auto">
              <table className={TABLE_CLASS}>
                <thead>
                  <tr className={THEAD_ROW_CLASS}>
                    <th className={`${TH_CLASS} text-left`}>Number</th>
                    <th className={`${TH_CLASS} text-left`}>Vendor</th>
                    <th className={TH_NUMERIC_CLASS}>COD</th>
                    <th className={TH_NUMERIC_CLASS}>Charges</th>
                    <th className={TH_NUMERIC_CLASS}>Deductions</th>
                    <th className={TH_NUMERIC_CLASS}>Net payable</th>
                    <th className={`${TH_CLASS} text-left`}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((settlement) => (
                    <tr key={settlement.id} className={TR_CLASS}>
                      <td className={TD_ID_CLASS}>
                        <Link href={`${detailBase}/${settlement.id}`} className="font-semibold text-primary">
                          {settlement.settlementNumber}
                        </Link>
                      </td>
                      <td className={TD_CLASS}>{settlement.vendorName ?? "—"}</td>
                      <td className={TD_NUMERIC_CLASS}>{formatPaisa(settlement.grossCodPaisa)}</td>
                      <td className={TD_NUMERIC_CLASS}>{formatPaisa(settlement.shippingChargesPaisa)}</td>
                      <td className={TD_NUMERIC_CLASS}>{formatPaisa(settlement.otherDeductionsPaisa)}</td>
                      <td className={`${TD_NUMERIC_CLASS} font-medium`}>{formatPaisa(settlement.netPayablePaisa)}</td>
                      <td className={TD_CLASS}>
                        <StatusBadge status={settlement.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </DensityScope>
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
            <div key={line.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-[13px]">
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
        <p className="text-[13px] text-ink-2">Payout reference: {settlement.paymentRef}</p>
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
            <div key={account.id} className="rounded-md border border-border px-3 py-2 text-[13px]">
              <div className="font-medium text-ink">{account.code}</div>
              <div className="tnum text-ink-2">
                {account.kind} · {formatPaisa(account.balancePaisa)}
              </div>
            </div>
          ))}
        </div>
      </SectionCard>
      <SectionCard title={`Journal entries (${meta.total})`}>
        <p className="mb-3 text-[12px] text-ink-2">
          Entries are append-only: corrections appear as new REVERSAL / ADJUSTMENT entries linked to the
          originals. Entries sharing a journal reference form one balanced journal.
        </p>
        {items.length === 0 ? (
          <p className="text-[13px] text-ink-2">No ledger entries yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="text-ink-2">
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
                  <tr key={entry.id} className="border-t border-border">
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
          <p className="text-[13px] text-ink-2">No adjustments yet.</p>
        ) : (
          <div className="grid gap-2">
            {adjustments.items.map((adjustment) => (
              <div key={adjustment.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-[13px]">
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
          <p className="text-[13px] text-ink-2">No refunds yet.</p>
        ) : (
          <div className="grid gap-2">
            {refunds.items.map((refund) => (
              <div key={refund.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-[13px]">
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
          <p className="text-[13px] text-ink-2">No invoices yet.</p>
        ) : (
          <div className="grid gap-2">
            {invoices.items.map((invoice) => (
              <div key={invoice.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-[13px]">
                <Link href={`/vendor/billing/invoices/${invoice.id}`} className="font-semibold text-primary">
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
          <p className="text-[13px] text-ink-2">No settlements yet.</p>
        ) : (
          <div className="grid gap-2">
            {settlements.items.map((settlement) => (
              <div key={settlement.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-[13px]">
                <Link href={`/vendor/billing/settlements/${settlement.id}`} className="font-semibold text-primary">
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
          <p className="text-[13px] text-ink-2">No remittances yet.</p>
        ) : (
          <div className="grid gap-2">
            {remittances.items.map((remittance) => (
              <div key={remittance.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-[13px]">
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
