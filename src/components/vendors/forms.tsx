"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import {
  addVendorAddressAction,
  addVendorDocumentAction,
  approveVendorAddressAction,
  assignVendorWarehouseAction,
  createVendorAction,
  reviewVendorDocumentAction,
  updateVendorAction,
  vendorVerificationAction,
} from "@/server/actions/vendors";
import { createInvitationAction } from "@/server/actions/invitations";
import {
  ErrorBox,
  inputClass,
  labelClass,
  primaryButtonClass,
  subtleButtonClass,
} from "@/components/warehouses/ui";
import type { VendorView } from "@/server/services/vendors";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      {children}
    </label>
  );
}

export function VendorForm({
  vendor,
  basePath,
}: {
  vendor?: VendorView;
  basePath: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const credit = String(form.get("creditLimitPaisa") ?? "").trim();
    const input = {
      businessName: String(form.get("businessName") ?? ""),
      registrationNumber: String(form.get("registrationNumber") ?? "") || null,
      contactName: String(form.get("contactName") ?? ""),
      email: String(form.get("email") ?? "") || null,
      phone: String(form.get("phone") ?? ""),
      billingPreference: String(form.get("billingPreference") ?? "COD_OFFSET") as
        | "PREPAID"
        | "CREDIT"
        | "COD_OFFSET",
      creditLimitPaisa: credit ? String(Math.round(Number(credit) * 100)) : null,
    };
    const result = vendor
      ? await updateVendorAction(vendor.id, input)
      : await createVendorAction(input);
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    router.push(`${basePath}/vendors/${result.data.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
      <Field label="Business name">
        <input name="businessName" required defaultValue={vendor?.businessName ?? ""} className={inputClass} />
      </Field>
      <Field label="Registration number">
        <input name="registrationNumber" defaultValue={vendor?.registrationNumber ?? ""} className={inputClass} />
      </Field>
      <Field label="Contact name">
        <input name="contactName" required defaultValue={vendor?.contactName ?? ""} className={inputClass} />
      </Field>
      <Field label="Phone">
        <input name="phone" required defaultValue={vendor?.phone ?? ""} className={inputClass} />
      </Field>
      <Field label="Email">
        <input name="email" type="email" defaultValue={vendor?.email ?? ""} className={inputClass} />
      </Field>
      <Field label="Billing preference">
        <select name="billingPreference" defaultValue={vendor?.billingPreference ?? "COD_OFFSET"} className={inputClass}>
          <option value="COD_OFFSET">COD offset</option>
          <option value="PREPAID">Prepaid</option>
          <option value="CREDIT">Credit</option>
        </select>
      </Field>
      <Field label="Credit limit (NPR)">
        <input
          name="creditLimitPaisa"
          type="number"
          min="0"
          step="0.01"
          defaultValue={vendor?.creditLimitPaisa ? Number(vendor.creditLimitPaisa) / 100 : ""}
          className={inputClass}
        />
      </Field>
      <div className="sm:col-span-2 flex items-center gap-3">
        <button type="submit" disabled={busy} className={primaryButtonClass}>
          {busy ? "Saving…" : vendor ? "Save changes" : "Create vendor"}
        </button>
        {error ? <ErrorBox message={error} /> : null}
      </div>
    </form>
  );
}

const VERIFICATION_NEXT: Record<string, string[]> = {
  PENDING_VERIFICATION: ["UNDER_REVIEW", "REJECTED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["SUSPENDED", "INACTIVE"],
  REJECTED: ["UNDER_REVIEW"],
  SUSPENDED: ["APPROVED", "INACTIVE"],
  INACTIVE: ["UNDER_REVIEW"],
};

export function VerificationControls({ vendor }: { vendor: VendorView }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = VERIFICATION_NEXT[vendor.verificationStatus] ?? [];

  async function move(target: string) {
    setBusy(true);
    setError(null);
    const result = await vendorVerificationAction(vendor.id, {
      target: target as never,
      notes: null,
    });
    setBusy(false);
    if (!result.success) setError(result.error);
    else router.refresh();
  }

  if (next.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {next.map((target) => (
        <button
          key={target}
          type="button"
          disabled={busy}
          onClick={() => move(target)}
          className={target === "APPROVED" ? primaryButtonClass : subtleButtonClass}
        >
          Move to {target.replaceAll("_", " ")}
        </button>
      ))}
      {error ? <ErrorBox message={error} /> : null}
    </div>
  );
}

export function VendorAddressForm({ vendorId, canApprove }: { vendorId: string; canApprove: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const result = await addVendorAddressAction(vendorId, {
      kind: String(form.get("kind") ?? "PICKUP") as "PICKUP" | "BILLING" | "OFFICE",
      addressLine1: String(form.get("addressLine1") ?? ""),
      addressLine2: String(form.get("addressLine2") ?? "") || null,
      city: String(form.get("city") ?? ""),
      district: String(form.get("district") ?? ""),
      province: String(form.get("province") ?? ""),
      postalCode: String(form.get("postalCode") ?? "") || null,
      contactName: String(form.get("contactName") ?? "") || null,
      contactPhone: String(form.get("contactPhone") ?? "") || null,
      approve: canApprove && form.get("approve") === "on",
    });
    setBusy(false);
    if (!result.success) setError(result.error);
    else router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2">
      <Field label="Kind">
        <select name="kind" className={inputClass} defaultValue="PICKUP">
          <option value="PICKUP">Pickup</option>
          <option value="BILLING">Billing</option>
          <option value="OFFICE">Office</option>
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
      <Field label="Contact phone">
        <input name="contactPhone" className={inputClass} />
      </Field>
      {canApprove ? (
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" name="approve" /> Approve for pickup immediately
        </label>
      ) : null}
      <div className="sm:col-span-2 flex items-center gap-3">
        <button type="submit" disabled={busy} className={subtleButtonClass}>
          {busy ? "Adding…" : "Add address"}
        </button>
        {error ? <ErrorBox message={error} /> : null}
      </div>
    </form>
  );
}

export function ApproveAddressButton({ vendorId, addressId }: { vendorId: string; addressId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      className={subtleButtonClass}
      onClick={async () => {
        setBusy(true);
        await approveVendorAddressAction(vendorId, addressId);
        setBusy(false);
        router.refresh();
      }}
    >
      Approve
    </button>
  );
}

export function VendorDocumentForm({ vendorId }: { vendorId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const size = String(form.get("sizeBytes") ?? "").trim();
    const result = await addVendorDocumentAction(vendorId, {
      documentType: String(form.get("documentType") ?? "OTHER") as never,
      fileName: String(form.get("fileName") ?? ""),
      mimeType: String(form.get("mimeType") ?? "") || null,
      sizeBytes: size ? Number(size) : null,
      storageKey: String(form.get("storageKey") ?? "") || null,
      sha256: String(form.get("sha256") ?? "") || null,
    });
    setBusy(false);
    if (!result.success) setError(result.error);
    else router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2">
      <Field label="Document type">
        <select name="documentType" className={inputClass} defaultValue="REGISTRATION">
          <option value="REGISTRATION">Business registration</option>
          <option value="PAN_VAT">PAN / VAT</option>
          <option value="TAX_CLEARANCE">Tax clearance</option>
          <option value="ID_PROOF">ID proof</option>
          <option value="OTHER">Other</option>
        </select>
      </Field>
      <Field label="File name">
        <input name="fileName" required className={inputClass} placeholder="registration.pdf" />
      </Field>
      <Field label="Storage key (private bucket)">
        <input name="storageKey" className={inputClass} />
      </Field>
      <Field label="Size (bytes)">
        <input name="sizeBytes" type="number" min="0" className={inputClass} />
      </Field>
      <div className="sm:col-span-2 flex items-center gap-3">
        <button type="submit" disabled={busy} className={subtleButtonClass}>
          {busy ? "Adding…" : "Add document record"}
        </button>
        {error ? <ErrorBox message={error} /> : null}
      </div>
    </form>
  );
}

export function ReviewDocumentButtons({ vendorId, documentId }: { vendorId: string; documentId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function review(decision: "APPROVED" | "REJECTED") {
    setBusy(true);
    await reviewVendorDocumentAction(vendorId, documentId, decision);
    setBusy(false);
    router.refresh();
  }
  return (
    <span className="flex gap-2">
      <button type="button" disabled={busy} className={subtleButtonClass} onClick={() => review("APPROVED")}>
        Approve
      </button>
      <button type="button" disabled={busy} className={subtleButtonClass} onClick={() => review("REJECTED")}>
        Reject
      </button>
    </span>
  );
}

export function VendorAssignmentForm({
  vendorId,
  warehouses,
}: {
  vendorId: string;
  warehouses: { id: string; code: string; name: string }[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const form = new FormData(event.currentTarget);
        const result = await assignVendorWarehouseAction(vendorId, String(form.get("warehouseId") ?? ""));
        setBusy(false);
        if (!result.success) setError(result.error);
        else router.refresh();
      }}
    >
      <Field label="Origin warehouse">
        <select name="warehouseId" className={inputClass} required>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code} — {w.name}
            </option>
          ))}
        </select>
      </Field>
      <button type="submit" disabled={busy} className={subtleButtonClass}>
        {busy ? "Assigning…" : "Assign"}
      </button>
      {error ? <ErrorBox message={error} /> : null}
    </form>
  );
}

export function VendorInviteForm({ vendorId }: { vendorId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setLink(null);
    const form = new FormData(event.currentTarget);
    const result = await createInvitationAction({
      email: String(form.get("email") ?? ""),
      roleCode: "VENDOR",
      vendorId,
      vendorRole: String(form.get("vendorRole") ?? "OWNER") as never,
    });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setLink(`/accept-invitation?token=${result.data.token}`);
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2">
      <Field label="Invitee email">
        <input name="email" type="email" required className={inputClass} />
      </Field>
      <Field label="Vendor role">
        <select name="vendorRole" className={inputClass} defaultValue="OWNER">
          <option value="OWNER">Owner</option>
          <option value="MANAGER">Manager</option>
          <option value="BOOKING_STAFF">Booking staff</option>
          <option value="ACCOUNTS_STAFF">Accounts staff</option>
        </select>
      </Field>
      <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy} className={subtleButtonClass}>
          {busy ? "Sending…" : "Create invitation"}
        </button>
        {error ? <ErrorBox message={error} /> : null}
        {link ? (
          <span className="text-[12px] text-slate2">
            Share this one-time accept link: <code className="break-all text-ink">{link}</code>
          </span>
        ) : null}
      </div>
    </form>
  );
}
