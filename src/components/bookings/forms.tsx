"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import {
  approveBookingAction,
  cancelBookingAction,
  createBookingAction,
  rejectBookingAction,
  updateBookingAction,
} from "@/server/actions/bookings";
import {
  ErrorBox,
  dangerButtonClass,
  inputClass,
  labelClass,
  primaryButtonClass,
  subtleButtonClass,
} from "@/components/warehouses/ui";
import type { BookingView } from "@/server/services/bookings";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      {children}
    </label>
  );
}

function rupeesToPaisaString(value: string): string {
  const rupees = Number(value);
  if (!Number.isFinite(rupees) || rupees <= 0) return "0";
  return String(Math.round(rupees * 100));
}

interface ItemDraft {
  description: string;
  quantity: number;
  weightKg: number;
  unitPrice: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  isFragile: boolean;
}

const EMPTY_ITEM: ItemDraft = {
  description: "",
  quantity: 1,
  weightKg: 1,
  unitPrice: "",
  lengthCm: "",
  widthCm: "",
  heightCm: "",
  isFragile: false,
};

export interface BookingCreateOptions {
  mode: "vendor" | "staff";
  basePath: string;
  warehouses: { id: string; code: string; name: string; city: string; district: string }[];
  services: { id: string; code: string; name: string }[];
  vendors?: { id: string; businessName: string }[];
  vendorAddresses?: {
    id: string;
    addressLine1: string;
    city: string;
    district: string;
    isApproved: boolean;
  }[];
}

export function BookingCreateForm(options: BookingCreateOptions) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickupMethod, setPickupMethod] = useState<"RIDER_PICKUP" | "WAREHOUSE_DROPOFF">(
    options.mode === "vendor" ? "RIDER_PICKUP" : "WAREHOUSE_DROPOFF",
  );
  const [vendorId, setVendorId] = useState<string>("");
  const [items, setItems] = useState<ItemDraft[]>([{ ...EMPTY_ITEM }]);

  function updateItem(index: number, patch: Partial<ItemDraft>) {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const senderName = String(form.get("senderName") ?? "");
    const result = await createBookingAction({
      vendorId: options.mode === "staff" && vendorId ? vendorId : null,
      sender:
        options.mode === "staff" && !vendorId
          ? {
              name: senderName,
              phone: String(form.get("senderPhone") ?? ""),
              email: String(form.get("senderEmail") ?? "") || null,
            }
          : null,
      recipient: {
        name: String(form.get("recipientName") ?? ""),
        phone: String(form.get("recipientPhone") ?? ""),
        altPhone: String(form.get("recipientAltPhone") ?? "") || null,
        email: String(form.get("recipientEmail") ?? "") || null,
        addressLine: String(form.get("recipientAddress") ?? ""),
        city: String(form.get("recipientCity") ?? ""),
        district: String(form.get("recipientDistrict") ?? ""),
        province: String(form.get("recipientProvince") ?? "") || null,
        municipality: String(form.get("recipientMunicipality") ?? "") || null,
        wardNumber: String(form.get("recipientWard") ?? "") || null,
        landmark: String(form.get("recipientLandmark") ?? "") || null,
      },
      pickup: {
        method: pickupMethod,
        vendorAddressId:
          pickupMethod === "RIDER_PICKUP" ? String(form.get("vendorAddressId") ?? "") || null : null,
        originWarehouseId:
          pickupMethod === "WAREHOUSE_DROPOFF"
            ? String(form.get("originWarehouseId") ?? "") || null
            : null,
      },
      shippingServiceCode: String(form.get("serviceCode") ?? "STANDARD"),
      paymentMethod: "CASH",
      codAmountPaisa: rupeesToPaisaString(String(form.get("codRupees") ?? "0")),
      deliveryInstructions: String(form.get("deliveryInstructions") ?? "") || null,
      notes: String(form.get("notes") ?? "") || null,
      items: items.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        weightKg: item.weightKg,
        unitPricePaisa: item.unitPrice ? rupeesToPaisaString(item.unitPrice) : null,
        lengthCm: item.lengthCm ? Number(item.lengthCm) : null,
        widthCm: item.widthCm ? Number(item.widthCm) : null,
        heightCm: item.heightCm ? Number(item.heightCm) : null,
        category: "PACKAGE" as const,
        isFragile: item.isFragile,
      })),
    });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    router.push(`${options.basePath}/bookings/${result.data.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-6">
      {options.mode === "staff" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Vendor (leave empty for a walk-in sender)">
            <select
              className={inputClass}
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
            >
              <option value="">Walk-in sender</option>
              {(options.vendors ?? []).map((vendor) => (
                <option key={vendor.id} value={vendor.id}>
                  {vendor.businessName}
                </option>
              ))}
            </select>
          </Field>
          {!vendorId ? (
            <>
              <Field label="Sender name">
                <input name="senderName" required className={inputClass} />
              </Field>
              <Field label="Sender phone">
                <input name="senderPhone" required className={inputClass} />
              </Field>
              <Field label="Sender email">
                <input name="senderEmail" type="email" className={inputClass} />
              </Field>
            </>
          ) : null}
        </div>
      ) : null}

      <fieldset className="grid gap-4">
        <legend className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
          Recipient
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Recipient name">
            <input name="recipientName" required className={inputClass} />
          </Field>
          <Field label="Recipient phone">
            <input name="recipientPhone" required className={inputClass} />
          </Field>
          <Field label="Alternate phone">
            <input name="recipientAltPhone" className={inputClass} />
          </Field>
          <Field label="Recipient email">
            <input name="recipientEmail" type="email" className={inputClass} />
          </Field>
          <Field label="Delivery address">
            <input name="recipientAddress" required className={inputClass} />
          </Field>
          <Field label="City">
            <input name="recipientCity" required className={inputClass} />
          </Field>
          <Field label="District (routes the booking)">
            <input name="recipientDistrict" required className={inputClass} placeholder="e.g. Kaski" />
          </Field>
          <Field label="Province">
            <input name="recipientProvince" className={inputClass} />
          </Field>
          <Field label="Municipality">
            <input name="recipientMunicipality" className={inputClass} />
          </Field>
          <Field label="Ward">
            <input name="recipientWard" className={inputClass} />
          </Field>
          <Field label="Landmark">
            <input name="recipientLandmark" className={inputClass} />
          </Field>
        </div>
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
          Pickup & service
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Pickup method">
            <select
              className={inputClass}
              value={pickupMethod}
              onChange={(e) => setPickupMethod(e.target.value as typeof pickupMethod)}
            >
              {options.mode === "vendor" ? <option value="RIDER_PICKUP">Rider pickup</option> : null}
              <option value="WAREHOUSE_DROPOFF">Warehouse drop-off</option>
            </select>
          </Field>
          {pickupMethod === "RIDER_PICKUP" ? (
            <Field label="Pickup address (approved)">
              <select name="vendorAddressId" className={inputClass} required>
                {(options.vendorAddresses ?? [])
                  .filter((a) => a.isApproved)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.addressLine1}, {a.city} ({a.district})
                    </option>
                  ))}
              </select>
            </Field>
          ) : (
            <Field label="Drop-off warehouse">
              <select name="originWarehouseId" className={inputClass} required>
                {options.warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} — {w.name} ({w.district})
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Shipping service">
            <select name="serviceCode" className={inputClass} defaultValue="STANDARD">
              {options.services.map((s) => (
                <option key={s.id} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Cash on delivery (NPR, 0 = none)">
            <input name="codRupees" type="number" min="0" step="0.01" defaultValue="0" className={inputClass} />
          </Field>
          <Field label="Delivery instructions">
            <input name="deliveryInstructions" className={inputClass} />
          </Field>
          <Field label="Notes">
            <input name="notes" className={inputClass} />
          </Field>
        </div>
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
          Items — one package is generated per unit
        </legend>
        {items.map((item, index) => (
          <div key={index} className="grid gap-3 rounded-md border border-line p-3 sm:grid-cols-3">
            <Field label="Description">
              <input
                required
                className={inputClass}
                value={item.description}
                onChange={(e) => updateItem(index, { description: e.target.value })}
              />
            </Field>
            <Field label="Quantity (parcels)">
              <input
                type="number"
                min={1}
                max={200}
                required
                className={inputClass}
                value={item.quantity}
                onChange={(e) => updateItem(index, { quantity: Number(e.target.value) })}
              />
            </Field>
            <Field label="Weight per parcel (kg)">
              <input
                type="number"
                min={0.01}
                step={0.01}
                required
                className={inputClass}
                value={item.weightKg}
                onChange={(e) => updateItem(index, { weightKg: Number(e.target.value) })}
              />
            </Field>
            <Field label="Declared value per parcel (NPR)">
              <input
                type="number"
                min={0}
                step={0.01}
                className={inputClass}
                value={item.unitPrice}
                onChange={(e) => updateItem(index, { unitPrice: e.target.value })}
              />
            </Field>
            <Field label="Dimensions L×W×H (cm, optional)">
              <span className="flex gap-1">
                <input
                  type="number"
                  min={0}
                  placeholder="L"
                  className={inputClass}
                  value={item.lengthCm}
                  onChange={(e) => updateItem(index, { lengthCm: e.target.value })}
                />
                <input
                  type="number"
                  min={0}
                  placeholder="W"
                  className={inputClass}
                  value={item.widthCm}
                  onChange={(e) => updateItem(index, { widthCm: e.target.value })}
                />
                <input
                  type="number"
                  min={0}
                  placeholder="H"
                  className={inputClass}
                  value={item.heightCm}
                  onChange={(e) => updateItem(index, { heightCm: e.target.value })}
                />
              </span>
            </Field>
            <label className="flex items-center gap-2 text-[13px] text-ink">
              <input
                type="checkbox"
                checked={item.isFragile}
                onChange={(e) => updateItem(index, { isFragile: e.target.checked })}
              />
              Fragile
            </label>
            {items.length > 1 ? (
              <button
                type="button"
                className={dangerButtonClass}
                onClick={() => setItems((current) => current.filter((_, i) => i !== index))}
              >
                Remove item
              </button>
            ) : null}
          </div>
        ))}
        <button
          type="button"
          className={subtleButtonClass}
          onClick={() => setItems((current) => [...current, { ...EMPTY_ITEM }])}
        >
          Add item
        </button>
      </fieldset>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className={primaryButtonClass}>
          {busy ? "Creating booking…" : "Create booking"}
        </button>
        {error ? <ErrorBox message={error} /> : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Detail-page controls
// ---------------------------------------------------------------------------

export function BookingApprovalControls({ booking }: { booking: BookingView }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");

  async function run(action: "approve" | "reject") {
    setBusy(true);
    setError(null);
    const result =
      action === "approve"
        ? await approveBookingAction(booking.id)
        : await rejectBookingAction(booking.id, reason || "Rejected by reviewer");
    setBusy(false);
    if (!result.success) setError(result.error);
    else router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={busy} className={primaryButtonClass} onClick={() => run("approve")}>
        Approve booking
      </button>
      <input
        className={inputClass}
        style={{ maxWidth: 260 }}
        placeholder="Rejection reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button type="button" disabled={busy} className={dangerButtonClass} onClick={() => run("reject")}>
        Reject
      </button>
      {error ? <ErrorBox message={error} /> : null}
    </div>
  );
}

export function BookingCancelControl({ booking }: { booking: BookingView }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const result = await cancelBookingAction(booking.id, reason || "Cancelled");
        setBusy(false);
        if (!result.success) setError(result.error);
        else router.refresh();
      }}
    >
      <input
        className={inputClass}
        style={{ maxWidth: 260 }}
        placeholder="Cancellation reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button type="submit" disabled={busy} className={dangerButtonClass}>
        Cancel booking
      </button>
      {error ? <ErrorBox message={error} /> : null}
    </form>
  );
}

export function BookingUpdateForm({ booking }: { booking: BookingView }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstPackage = booking.shipments[0]?.packages[0];
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const form = new FormData(event.currentTarget);
        const result = await updateBookingAction(booking.id, {
          recipientName: String(form.get("recipientName") ?? ""),
          recipientPhone: String(form.get("recipientPhone") ?? ""),
          deliveryAddress: String(form.get("deliveryAddress") ?? ""),
          deliveryCity: String(form.get("deliveryCity") ?? ""),
          landmark: String(form.get("landmark") ?? "") || null,
          deliveryInstructions: String(form.get("deliveryInstructions") ?? "") || null,
        });
        setBusy(false);
        if (!result.success) setError(result.error);
        else router.refresh();
      }}
    >
      <Field label="Recipient name">
        <input name="recipientName" required defaultValue={firstPackage?.recipientName ?? ""} className={inputClass} />
      </Field>
      <Field label="Recipient phone">
        <input name="recipientPhone" required defaultValue={firstPackage?.recipientPhone ?? ""} className={inputClass} />
      </Field>
      <Field label="Delivery address">
        <input name="deliveryAddress" required defaultValue={firstPackage?.deliveryAddress ?? ""} className={inputClass} />
      </Field>
      <Field label="Delivery city">
        <input name="deliveryCity" required defaultValue={firstPackage?.deliveryCity ?? ""} className={inputClass} />
      </Field>
      <Field label="Landmark">
        <input name="landmark" defaultValue={firstPackage?.landmark ?? ""} className={inputClass} />
      </Field>
      <Field label="Delivery instructions">
        <input name="deliveryInstructions" defaultValue={booking.deliveryInstructions ?? ""} className={inputClass} />
      </Field>
      <div className="sm:col-span-2 flex items-center gap-3">
        <button type="submit" disabled={busy} className={subtleButtonClass}>
          {busy ? "Saving…" : "Save corrections"}
        </button>
        {error ? <ErrorBox message={error} /> : null}
      </div>
    </form>
  );
}
