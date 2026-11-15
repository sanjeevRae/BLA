import QRCode from "qrcode";

import type { ActorContext } from "@/lib/auth/actor";
import { getPackageLabel } from "@/server/services/packages";
import { formatPaisa } from "@/components/bookings/ui";
import { PrintButton } from "@/components/packages/PrintButton";

/**
 * Printable package label (schema doc §5): sender, receiver name /
 * district, tracking ID and a QR code encoding the public tracking
 * URL. The QR is generated locally with the `qrcode` library — no
 * external service. Rendering counts as a print in PackageLabel.
 */
export async function PackageLabelCard({
  actor,
  packageId,
  baseUrl,
}: {
  actor: ActorContext;
  packageId: string;
  baseUrl: string;
}) {
  const label = await getPackageLabel(actor, packageId, baseUrl);
  const qrDataUrl = await QRCode.toDataURL(label.qrPayload, {
    width: 180,
    margin: 1,
    errorCorrectionLevel: "M",
  });
  return (
    <div className="print-label w-[380px] rounded-lg border-2 border-ink bg-white p-4 text-ink">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[15px] font-bold">BLA Logistics</div>
          <div className="text-[11px] uppercase tracking-[0.14em]">Package label</div>
          <div className="mt-1 text-[12px]">
            {label.originWarehouseCode ?? "—"} → {label.destinationWarehouseCode ?? "HELD"}
          </div>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qrDataUrl} alt={`QR code for tracking ${label.trackingId}`} width={92} height={92} />
      </div>
      <div className="mt-2 border-t border-dashed border-ink pt-2">
        <div className="text-[11px] uppercase tracking-[0.14em]">Tracking ID</div>
        <div className="font-mono text-[19px] font-bold tracking-wide">{label.trackingId}</div>
        <div className="text-[12px]">Order {label.orderNumber}</div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3 border-t border-dashed border-ink pt-2 text-[12px]">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em]">From</div>
          <div className="font-semibold">{label.senderName}</div>
          <div>{label.senderPhone}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em]">To</div>
          <div className="font-semibold">{label.recipientName}</div>
          <div>
            {label.deliveryAddress}, {label.recipientCity}
          </div>
          <div>
            <strong>{label.recipientDistrict}</strong>
            {label.landmark ? ` · near ${label.landmark}` : ""}
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between border-t border-dashed border-ink pt-2 text-[12px]">
        <span>
          {label.description} · {label.weightKg} kg
          {label.isFragile ? " · FRAGILE" : ""}
        </span>
        <span className="font-semibold">
          {BigInt(label.codAmountPaisa) > BigInt(0)
            ? `COD ${formatPaisa(label.codAmountPaisa)}`
            : "No COD"}
        </span>
      </div>
      <div className="mt-3">
        <PrintButton />
      </div>
    </div>
  );
}
