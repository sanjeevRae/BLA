import type { ReactNode } from "react";

import { formatPaisa } from "@/components/bookings/ui";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { TransferView } from "@/server/services/transfers";

/**
 * TransferSummaryCard (V3 Step 9, DS §10) — an ADDITIVE summary
 * surface on the transfer detail page, rendered directly under the
 * page header. It is composed ONLY from TransferView fields the
 * detail page already renders:
 *
 *   transferNumber, status,
 *   originWarehouseName / originWarehouseCode,
 *   destinationWarehouseName / destinationWarehouseCode,
 *   driverName, vehicleRegistration,
 *   expectedArrivalAt, dispatchedAt,
 *   createdByName, approvedByName,
 *   and, when transfer.manifest exists:
 *   manifest.manifestCode, manifest.packageCount,
 *   manifest.totalWeightKg, manifest.totalCodPaisa.
 *
 * Presentation only: no new data, no actions, no behaviour.
 */

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-ink-2">{label}</dt>
      <dd className="font-medium text-ink">{children}</dd>
    </div>
  );
}

export function TransferSummaryCard({ transfer }: { transfer: TransferView }) {
  const manifest = transfer.manifest;
  return (
    <section
      aria-label={`Transfer ${transfer.transferNumber} summary`}
      className="rounded-lg border border-border bg-card p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-[14px] text-ink">
          <span className="font-mono font-semibold">{transfer.transferNumber}</span>
          <span aria-hidden="true" className="text-ink-2">
            ·
          </span>
          <span className="font-mono font-semibold">{transfer.originWarehouseCode}</span>
          <span aria-hidden="true">→</span>
          <span className="font-mono font-semibold">{transfer.destinationWarehouseCode}</span>
          <span className="text-ink-2">
            {transfer.originWarehouseName} → {transfer.destinationWarehouseName}
          </span>
        </div>
        <StatusBadge domain="generic" status={transfer.status} />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-3 lg:grid-cols-6">
        <Fact label="Driver">{transfer.driverName ?? "Not assigned"}</Fact>
        <Fact label="Vehicle">{transfer.vehicleRegistration ?? "Not assigned"}</Fact>
        <Fact label="Dispatched">{fmtDate(transfer.dispatchedAt)}</Fact>
        <Fact label="Expected arrival">{fmtDate(transfer.expectedArrivalAt)}</Fact>
        <Fact label="Created by">{transfer.createdByName}</Fact>
        <Fact label="Approved by">{transfer.approvedByName ?? "—"}</Fact>
      </dl>

      {manifest ? (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-[13px]">
          <span className="font-semibold text-ink-2">Manifest</span>
          <span className="font-mono font-semibold text-ink">{manifest.manifestCode}</span>
          <span className="text-ink">
            {manifest.packageCount} package{manifest.packageCount === 1 ? "" : "s"}
          </span>
          <span className="text-ink tabular-nums">{manifest.totalWeightKg} kg</span>
          <span className="text-ink tabular-nums">
            COD {formatPaisa(BigInt(manifest.totalCodPaisa))}
          </span>
        </div>
      ) : null}
    </section>
  );
}
