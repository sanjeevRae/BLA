"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import {
  addCustomerAddressAction,
  createCustomerAction,
  mergeCustomersAction,
  updateCustomerAction,
} from "@/server/actions/customers";
import {
  ErrorBox,
  inputClass,
  labelClass,
  primaryButtonClass,
  subtleButtonClass,
} from "@/components/warehouses/ui";
import type { CustomerView } from "@/server/services/customers";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      {children}
    </label>
  );
}

export function CustomerForm({ customer, basePath }: { customer?: CustomerView; basePath: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const input = {
      fullName: String(form.get("fullName") ?? ""),
      phone: String(form.get("phone") ?? ""),
      email: String(form.get("email") ?? "") || null,
    };
    const result = customer
      ? await updateCustomerAction(customer.id, input)
      : await createCustomerAction(input);
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    router.push(`${basePath}/customers`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
      <Field label="Full name">
        <input name="fullName" required defaultValue={customer?.fullName ?? ""} className={inputClass} />
      </Field>
      <Field label="Phone">
        <input name="phone" required defaultValue={customer?.phone ?? ""} className={inputClass} />
      </Field>
      <Field label="Email">
        <input name="email" type="email" defaultValue={customer?.email ?? ""} className={inputClass} />
      </Field>
      <div className="sm:col-span-2 flex items-center gap-3">
        <button type="submit" disabled={busy} className={primaryButtonClass}>
          {busy ? "Saving…" : customer ? "Save changes" : "Create customer"}
        </button>
        {error ? <ErrorBox message={error} /> : null}
      </div>
    </form>
  );
}

export function CustomerAddressForm({ customerId }: { customerId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const result = await addCustomerAddressAction(customerId, {
      kind: String(form.get("kind") ?? "DELIVERY") as "PICKUP" | "DELIVERY" | "HOME",
      addressLine1: String(form.get("addressLine1") ?? ""),
      addressLine2: String(form.get("addressLine2") ?? "") || null,
      city: String(form.get("city") ?? ""),
      district: String(form.get("district") ?? ""),
      province: String(form.get("province") ?? ""),
      municipality: String(form.get("municipality") ?? "") || null,
      wardNumber: String(form.get("wardNumber") ?? "") || null,
      landmark: String(form.get("landmark") ?? "") || null,
      postalCode: String(form.get("postalCode") ?? "") || null,
      isDefault: form.get("isDefault") === "on",
    });
    setBusy(false);
    if (!result.success) setError(result.error);
    else router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2">
      <Field label="Kind">
        <select name="kind" className={inputClass} defaultValue="DELIVERY">
          <option value="DELIVERY">Delivery</option>
          <option value="PICKUP">Pickup</option>
          <option value="HOME">Home</option>
        </select>
      </Field>
      <Field label="Address line 1">
        <input name="addressLine1" required className={inputClass} />
      </Field>
      <Field label="City">
        <input name="city" required className={inputClass} />
      </Field>
      <Field label="District">
        <input name="district" required className={inputClass} />
      </Field>
      <Field label="Province">
        <input name="province" required className={inputClass} />
      </Field>
      <Field label="Landmark">
        <input name="landmark" className={inputClass} />
      </Field>
      <label className="flex items-center gap-2 text-[13px] text-ink">
        <input type="checkbox" name="isDefault" /> Default address
      </label>
      <div className="sm:col-span-2 flex items-center gap-3">
        <button type="submit" disabled={busy} className={subtleButtonClass}>
          {busy ? "Adding…" : "Add address"}
        </button>
        {error ? <ErrorBox message={error} /> : null}
      </div>
    </form>
  );
}

export function MergeCustomerForm({
  winnerId,
  others,
}: {
  winnerId: string;
  others: { id: string; fullName: string; phone: string }[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (others.length === 0) return null;
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const form = new FormData(event.currentTarget);
        const result = await mergeCustomersAction(winnerId, String(form.get("loserId") ?? ""));
        setBusy(false);
        if (!result.success) setError(result.error);
        else router.refresh();
      }}
    >
      <Field label="Merge duplicate into this record">
        <select name="loserId" className={inputClass} required>
          {others.map((o) => (
            <option key={o.id} value={o.id}>
              {o.fullName} — {o.phone}
            </option>
          ))}
        </select>
      </Field>
      <button type="submit" disabled={busy} className={subtleButtonClass}>
        {busy ? "Merging…" : "Merge"}
      </button>
      {error ? <ErrorBox message={error} /> : null}
    </form>
  );
}
