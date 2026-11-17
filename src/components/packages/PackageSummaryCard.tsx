import { formatPaisa } from "@/components/bookings/ui";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { TD_ID_CLASS } from "@/components/ui/table-chrome";
import type { StatusDomain } from "@/lib/status/status-tones";

/**
 * PackageSummaryCard (V3 Step 9, DS §4 + §10) — the booking-detail
 * package surface, replacing the packages table inside each shipment
 * block. Presentation only: it composes ONLY the fields the old table
 * (and its labelled badge stack) already exposed on PackageView.
 *
 * Field map (PackageView → card):
 * - trackingId          → header identifier (mono, TD_ID styling)
 * - operationalStatus   → "Operational" domain chip
 * - condition           → "Condition" domain chip
 * - paymentStatus       → "Payment" domain chip
 * - deliveryStatus      → "Delivery" domain chip
 * - exceptionStatus     → "Exception" domain chip (ALWAYS rendered,
 *                         including NONE → its friendly label "None")
 * - recipientName + deliveryCity / deliveryDistrict → Recipient row
 * - description         → Contents row
 * - billableWeightKg ?? declaredWeightKg → Weight row
 * - codAmountPaisa      → COD row (via formatPaisa)
 *
 * The five domain chips render in the FIXED DS §4 order —
 * Operational · Condition · Payment · Delivery · Exception — each a
 * small ink-2 domain label plus the shared StatusBadge at compact
 * density, so status text is always the friendly dictionary label,
 * never the raw enum.
 */
export interface PackageSummary {
  trackingId: string;
  recipientName: string;
  deliveryCity: string;
  deliveryDistrict: string;
  description: string;
  billableWeightKg: string | null;
  declaredWeightKg: string;
  codAmountPaisa: string;
  operationalStatus: string;
  condition: string;
  paymentStatus: string;
  deliveryStatus: string;
  exceptionStatus: string;
}

const DOMAIN_CHIPS: ReadonlyArray<{
  label: string;
  domain: StatusDomain;
  pick: (pkg: PackageSummary) => string;
}> = [
  { label: "Operational", domain: "operational", pick: (pkg) => pkg.operationalStatus },
  { label: "Condition", domain: "condition", pick: (pkg) => pkg.condition },
  { label: "Payment", domain: "payment", pick: (pkg) => pkg.paymentStatus },
  { label: "Delivery", domain: "delivery", pick: (pkg) => pkg.deliveryStatus },
  { label: "Exception", domain: "exception", pick: (pkg) => pkg.exceptionStatus },
];

export function PackageSummaryCard({ pkg }: { pkg: PackageSummary }) {
  return (
    <article className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className={TD_ID_CLASS}>{pkg.trackingId}</span>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {DOMAIN_CHIPS.map((chip) => (
            <span key={chip.domain} className="inline-flex items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">
                {chip.label}
              </span>
              <StatusBadge domain={chip.domain} status={chip.pick(pkg)} density="compact" />
            </span>
          ))}
        </div>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-semibold text-ink-2">Recipient</dt>
          <dd className="text-ink">
            {pkg.recipientName} — {pkg.deliveryCity}, {pkg.deliveryDistrict}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-semibold text-ink-2">Contents</dt>
          <dd className="text-ink">{pkg.description}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-semibold text-ink-2">Weight</dt>
          <dd className="text-ink tabular-nums">
            {pkg.billableWeightKg ?? pkg.declaredWeightKg} kg
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-semibold text-ink-2">COD</dt>
          <dd className="text-ink tabular-nums">{formatPaisa(pkg.codAmountPaisa)}</dd>
        </div>
      </dl>
    </article>
  );
}
