"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";

import { createBulkBookingsAction } from "@/server/actions/bookings";
import {
  ErrorBox,
  dangerButtonClass,
  inputClass,
  labelClass,
  primaryButtonClass,
  subtleButtonClass,
} from "@/components/warehouses/ui";
import type { BookingView } from "@/server/services/bookings";

/**
 * Phase 7 vendor bulk booking form. Every row is one complete booking
 * carrying exactly the fields of the single-booking form
 * (components/bookings/forms.tsx BookingCreateForm, vendor mode):
 * recipient, pickup & service, and the item list (one package per
 * unit). ONE submit creates all rows through createBulkBookings —
 * all-or-nothing server-side — so on error the server message
 * (including its "Row N: …" context) is shown and every entered value
 * stays in place; there is no partial success state to present.
 */

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

interface BulkRowDraft {
  recipientName: string;
  recipientPhone: string;
  recipientAltPhone: string;
  recipientEmail: string;
  recipientAddress: string;
  recipientCity: string;
  recipientDistrict: string;
  recipientProvince: string;
  recipientMunicipality: string;
  recipientWard: string;
  recipientLandmark: string;
  pickupMethod: "RIDER_PICKUP" | "WAREHOUSE_DROPOFF";
  vendorAddressId: string;
  originWarehouseId: string;
  serviceCode: string;
  codRupees: string;
  deliveryInstructions: string;
  notes: string;
  items: ItemDraft[];
}

export interface BulkBookingCreateOptions {
  basePath: string;
  warehouses: { id: string; code: string; name: string; city: string; district: string }[];
  services: { id: string; code: string; name: string }[];
  vendorAddresses?: {
    id: string;
    addressLine1: string;
    city: string;
    district: string;
    isApproved: boolean;
  }[];
}

const MAX_ROWS = 50;

export function BulkBookingCreateForm(options: BulkBookingCreateOptions) {
  const approvedAddresses = (options.vendorAddresses ?? []).filter((a) => a.isApproved);

  function emptyRow(): BulkRowDraft {
    return {
      recipientName: "",
      recipientPhone: "",
      recipientAltPhone: "",
      recipientEmail: "",
      recipientAddress: "",
      recipientCity: "",
      recipientDistrict: "",
      recipientProvince: "",
      recipientMunicipality: "",
      recipientWard: "",
      recipientLandmark: "",
      pickupMethod: "RIDER_PICKUP",
      vendorAddressId: approvedAddresses[0]?.id ?? "",
      originWarehouseId: options.warehouses[0]?.id ?? "",
      serviceCode: options.services.some((s) => s.code === "STANDARD")
        ? "STANDARD"
        : (options.services[0]?.code ?? "STANDARD"),
      codRupees: "0",
      deliveryInstructions: "",
      notes: "",
      items: [{ ...EMPTY_ITEM }],
    };
  }

  const [rows, setRows] = useState<BulkRowDraft[]>(() => [emptyRow()]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<BookingView[] | null>(null);

  function updateRow(index: number, patch: Partial<BulkRowDraft>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function updateItem(rowIndex: number, itemIndex: number, patch: Partial<ItemDraft>) {
    setRows((current) =>
      current.map((row, i) =>
        i === rowIndex
          ? {
              ...row,
              items: row.items.map((item, j) => (j === itemIndex ? { ...item, ...patch } : item)),
            }
          : row,
      ),
    );
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setCreated(null);
    const result = await createBulkBookingsAction({
      orders: rows.map((row) => ({
        vendorId: null,
        sender: null,
        recipient: {
          name: row.recipientName,
          phone: row.recipientPhone,
          altPhone: row.recipientAltPhone || null,
          email: row.recipientEmail || null,
          addressLine: row.recipientAddress,
          city: row.recipientCity,
          district: row.recipientDistrict,
          province: row.recipientProvince || null,
          municipality: row.recipientMunicipality || null,
          wardNumber: row.recipientWard || null,
          landmark: row.recipientLandmark || null,
        },
        pickup: {
          method: row.pickupMethod,
          vendorAddressId: row.pickupMethod === "RIDER_PICKUP" ? row.vendorAddressId || null : null,
          originWarehouseId:
            row.pickupMethod === "WAREHOUSE_DROPOFF" ? row.originWarehouseId || null : null,
        },
        shippingServiceCode: row.serviceCode,
        paymentMethod: "CASH" as const,
        codAmountPaisa: rupeesToPaisaString(row.codRupees),
        deliveryInstructions: row.deliveryInstructions || null,
        notes: row.notes || null,
        items: row.items.map((item) => ({
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
      })),
    });
    setBusy(false);
    if (!result.success) {
      // Nothing was created (all-or-nothing): keep every entered
      // value and show the server's message, row context included.
      setError(result.error);
      return;
    }
    setCreated(result.data);
  }

  if (created) {
    return (
      <div className="grid gap-4">
        <p className="text-[13px] text-ink">
          Created {created.length} booking{created.length === 1 ? "" : "s"}:
        </p>
        <ul className="grid gap-2">
          {created.map((booking) => (
            <li
              key={booking.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
            >
              <Link
                href={`${options.basePath}/bookings/${booking.id}`}
                className="font-semibold text-brand"
              >
                {booking.orderNumber}
              </Link>
              <span className="text-ink">
                → {booking.destinationDistrict} ·{" "}
                {booking.shipments.reduce((n, s) => n + s.packages.length, 0)} parcel(s) ·{" "}
                {booking.shipments
                  .flatMap((s) => s.packages.map((p) => p.trackingId))
                  .join(", ")}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <button
            type="button"
            className={subtleButtonClass}
            onClick={() => {
              setCreated(null);
              setRows([emptyRow()]);
            }}
          >
            Book another batch
          </button>
          <Link href={`${options.basePath}/bookings`} className={subtleButtonClass}>
            Back to bookings
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-6">
      <p className="text-[13px] text-faint">
        Add up to {MAX_ROWS} bookings and submit them together. Either every booking is created or
        none is — if a row fails, the error names the row and nothing is booked.
      </p>
      {rows.map((row, rowIndex) => (
        <fieldset key={rowIndex} className="grid gap-4 rounded-md border border-line p-4">
          <legend className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
            Booking {rowIndex + 1} of {rows.length}
          </legend>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Recipient name">
              <input
                required
                className={inputClass}
                value={row.recipientName}
                onChange={(e) => updateRow(rowIndex, { recipientName: e.target.value })}
              />
            </Field>
            <Field label="Recipient phone">
              <input
                required
                className={inputClass}
                value={row.recipientPhone}
                onChange={(e) => updateRow(rowIndex, { recipientPhone: e.target.value })}
              />
            </Field>
            <Field label="Alternate phone">
              <input
                className={inputClass}
                value={row.recipientAltPhone}
                onChange={(e) => updateRow(rowIndex, { recipientAltPhone: e.target.value })}
              />
            </Field>
            <Field label="Recipient email">
              <input
                type="email"
                className={inputClass}
                value={row.recipientEmail}
                onChange={(e) => updateRow(rowIndex, { recipientEmail: e.target.value })}
              />
            </Field>
            <Field label="Delivery address">
              <input
                required
                className={inputClass}
                value={row.recipientAddress}
                onChange={(e) => updateRow(rowIndex, { recipientAddress: e.target.value })}
              />
            </Field>
            <Field label="City">
              <input
                required
                className={inputClass}
                value={row.recipientCity}
                onChange={(e) => updateRow(rowIndex, { recipientCity: e.target.value })}
              />
            </Field>
            <Field label="District (routes the booking)">
              <input
                required
                className={inputClass}
                placeholder="e.g. Kaski"
                value={row.recipientDistrict}
                onChange={(e) => updateRow(rowIndex, { recipientDistrict: e.target.value })}
              />
            </Field>
            <Field label="Province">
              <input
                className={inputClass}
                value={row.recipientProvince}
                onChange={(e) => updateRow(rowIndex, { recipientProvince: e.target.value })}
              />
            </Field>
            <Field label="Municipality">
              <input
                className={inputClass}
                value={row.recipientMunicipality}
                onChange={(e) => updateRow(rowIndex, { recipientMunicipality: e.target.value })}
              />
            </Field>
            <Field label="Ward">
              <input
                className={inputClass}
                value={row.recipientWard}
                onChange={(e) => updateRow(rowIndex, { recipientWard: e.target.value })}
              />
            </Field>
            <Field label="Landmark">
              <input
                className={inputClass}
                value={row.recipientLandmark}
                onChange={(e) => updateRow(rowIndex, { recipientLandmark: e.target.value })}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Pickup method">
              <select
                className={inputClass}
                value={row.pickupMethod}
                onChange={(e) =>
                  updateRow(rowIndex, {
                    pickupMethod: e.target.value as BulkRowDraft["pickupMethod"],
                  })
                }
              >
                <option value="RIDER_PICKUP">Rider pickup</option>
                <option value="WAREHOUSE_DROPOFF">Warehouse drop-off</option>
              </select>
            </Field>
            {row.pickupMethod === "RIDER_PICKUP" ? (
              <Field label="Pickup address (approved)">
                <select
                  className={inputClass}
                  required
                  value={row.vendorAddressId}
                  onChange={(e) => updateRow(rowIndex, { vendorAddressId: e.target.value })}
                >
                  {approvedAddresses.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.addressLine1}, {a.city} ({a.district})
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field label="Drop-off warehouse">
                <select
                  className={inputClass}
                  required
                  value={row.originWarehouseId}
                  onChange={(e) => updateRow(rowIndex, { originWarehouseId: e.target.value })}
                >
                  {options.warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} — {w.name} ({w.district})
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Shipping service">
              <select
                className={inputClass}
                value={row.serviceCode}
                onChange={(e) => updateRow(rowIndex, { serviceCode: e.target.value })}
              >
                {options.services.map((s) => (
                  <option key={s.id} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Cash on delivery (NPR, 0 = none)">
              <input
                type="number"
                min="0"
                step="0.01"
                className={inputClass}
                value={row.codRupees}
                onChange={(e) => updateRow(rowIndex, { codRupees: e.target.value })}
              />
            </Field>
            <Field label="Delivery instructions">
              <input
                className={inputClass}
                value={row.deliveryInstructions}
                onChange={(e) => updateRow(rowIndex, { deliveryInstructions: e.target.value })}
              />
            </Field>
            <Field label="Notes">
              <input
                className={inputClass}
                value={row.notes}
                onChange={(e) => updateRow(rowIndex, { notes: e.target.value })}
              />
            </Field>
          </div>

          <div className="grid gap-3">
            <span className={labelClass}>Items — one package is generated per unit</span>
            {row.items.map((item, itemIndex) => (
              <div
                key={itemIndex}
                className="grid gap-3 rounded-md border border-line p-3 sm:grid-cols-3"
              >
                <Field label="Description">
                  <input
                    required
                    className={inputClass}
                    value={item.description}
                    onChange={(e) =>
                      updateItem(rowIndex, itemIndex, { description: e.target.value })
                    }
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
                    onChange={(e) =>
                      updateItem(rowIndex, itemIndex, { quantity: Number(e.target.value) })
                    }
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
                    onChange={(e) =>
                      updateItem(rowIndex, itemIndex, { weightKg: Number(e.target.value) })
                    }
                  />
                </Field>
                <Field label="Declared value per parcel (NPR)">
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    className={inputClass}
                    value={item.unitPrice}
                    onChange={(e) =>
                      updateItem(rowIndex, itemIndex, { unitPrice: e.target.value })
                    }
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
                      onChange={(e) =>
                        updateItem(rowIndex, itemIndex, { lengthCm: e.target.value })
                      }
                    />
                    <input
                      type="number"
                      min={0}
                      placeholder="W"
                      className={inputClass}
                      value={item.widthCm}
                      onChange={(e) =>
                        updateItem(rowIndex, itemIndex, { widthCm: e.target.value })
                      }
                    />
                    <input
                      type="number"
                      min={0}
                      placeholder="H"
                      className={inputClass}
                      value={item.heightCm}
                      onChange={(e) =>
                        updateItem(rowIndex, itemIndex, { heightCm: e.target.value })
                      }
                    />
                  </span>
                </Field>
                <label className="flex items-center gap-2 text-[13px] text-ink">
                  <input
                    type="checkbox"
                    checked={item.isFragile}
                    onChange={(e) =>
                      updateItem(rowIndex, itemIndex, { isFragile: e.target.checked })
                    }
                  />
                  Fragile
                </label>
                {row.items.length > 1 ? (
                  <button
                    type="button"
                    className={dangerButtonClass}
                    onClick={() =>
                      updateRow(rowIndex, {
                        items: row.items.filter((_, j) => j !== itemIndex),
                      })
                    }
                  >
                    Remove item
                  </button>
                ) : null}
              </div>
            ))}
            <button
              type="button"
              className={subtleButtonClass}
              onClick={() =>
                updateRow(rowIndex, { items: [...row.items, { ...EMPTY_ITEM }] })
              }
            >
              Add item
            </button>
          </div>

          {rows.length > 1 ? (
            <div>
              <button
                type="button"
                className={dangerButtonClass}
                onClick={() => setRows((current) => current.filter((_, i) => i !== rowIndex))}
              >
                Remove booking {rowIndex + 1}
              </button>
            </div>
          ) : null}
        </fieldset>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={subtleButtonClass}
          disabled={rows.length >= MAX_ROWS}
          onClick={() => setRows((current) => [...current, emptyRow()])}
        >
          Add booking row ({rows.length}/{MAX_ROWS})
        </button>
        <button type="submit" disabled={busy} className={primaryButtonClass}>
          {busy ? "Creating bookings…" : `Create ${rows.length} booking${rows.length === 1 ? "" : "s"}`}
        </button>
        {error ? <ErrorBox message={error} /> : null}
      </div>
    </form>
  );
}
