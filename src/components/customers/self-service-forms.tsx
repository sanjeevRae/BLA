"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { INCIDENT_CUSTOMER_FACING_CATEGORIES } from "@/lib/operations/domain";
import { Select, TextArea, TextInput } from "@/components/ui/forms";
import { ErrorBox, primaryButtonClass } from "@/components/warehouses/ui";
import { createIncidentAction } from "@/server/actions/operations";
import { changePasswordAction } from "@/server/actions/users";

/**
 * Customer self-service forms (V2 Phase 6, audit M-3). Both forms call
 * the existing server actions; all permission and scope enforcement
 * stays in the services (createIncident validates that a linked
 * package/order belongs to the reporting customer and audits denials;
 * changePassword verifies the current password server-side).
 */

export interface IncidentLinkOption {
  value: string; // "package:<id>" or "order:<id>"
  label: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  CUSTOMER_COMPLAINT: "Complaint",
  DELIVERY_FAILURE: "Delivery failure",
  INCORRECT_ADDRESS: "Incorrect address",
  CUSTOMER_REFUSAL: "Customer refusal",
  DAMAGED_PACKAGE: "Damaged package",
  MISSING_PACKAGE: "Missing package",
  PAYMENT_DISPUTE: "Payment dispute",
};

/**
 * Report-an-incident form. The two entry points stay gated exactly as
 * the permission catalog separates them:
 *  - the general report (customer-facing categories) shows only with
 *    `incident.report`;
 *  - the PAYMENT_DISPUTE category — labelled "Payment dispute" — is
 *    added only with `payment.dispute.raise`, and choosing it requires
 *    linking one of the customer's own orders (the dispute is filed as
 *    an incident in that category against that order; there is no
 *    separate dispute subsystem).
 */
export function CustomerIncidentForm({
  canReport,
  canDispute,
  packageOptions,
  orderOptions,
}: {
  canReport: boolean;
  canDispute: boolean;
  packageOptions: IncidentLinkOption[];
  orderOptions: IncidentLinkOption[];
}) {
  const router = useRouter();
  const categories = [
    ...(canReport ? [...INCIDENT_CUSTOMER_FACING_CATEGORIES] : []),
    ...(canDispute ? ["PAYMENT_DISPUTE"] : []),
  ];
  const [category, setCategory] = useState<string>(categories[0] ?? "");
  const [description, setDescription] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDispute = category === "PAYMENT_DISPUTE";
  const linkOptions = isDispute ? orderOptions : [...packageOptions, ...orderOptions];

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (isDispute && !link.startsWith("order:")) {
      setError("A payment dispute must be linked to one of your orders — choose the order below.");
      return;
    }
    const [linkKind, linkId] = link ? link.split(":") : [null, null];
    setBusy(true);
    const result = await createIncidentAction({
      category: category as never,
      description,
      packageId: linkKind === "package" ? linkId! : undefined,
      orderId: linkKind === "order" ? linkId! : undefined,
    });
    setBusy(false);
    if (!result.success) {
      setError(result.error ?? "Something went wrong");
      return;
    }
    router.push("/customer/incidents");
    router.refresh();
  }

  if (categories.length === 0) return null;

  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <Select
        id="incident-category"
        label="What is this about?"
        value={category}
        onChange={(e) => {
          setCategory(e.target.value);
          setLink("");
        }}
        required
      >
        {categories.map((c) => (
          <option key={c} value={c}>
            {CATEGORY_LABELS[c] ?? c.replaceAll("_", " ")}
          </option>
        ))}
      </Select>
      {isDispute ? (
        <p className="rounded-md border border-line bg-accentbg px-3 py-2 text-[13px] text-ink">
          A payment dispute is raised against one of your orders and goes to the finance team.
          Link the order the payment belongs to, and describe the amount and what looks wrong.
        </p>
      ) : null}
      <Select
        id="incident-link"
        label={isDispute ? "Your order" : "Link to your package or order (optional)"}
        value={link}
        onChange={(e) => setLink(e.target.value)}
        required={isDispute}
        hint={
          isDispute
            ? "Choose the order you placed that the payment belongs to."
            : "Linking the package or order helps support find it faster."
        }
      >
        <option value="">{isDispute ? "Choose an order…" : "No link"}</option>
        {linkOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      <TextArea
        id="incident-description"
        label="What happened?"
        rows={4}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        required
        minLength={5}
        maxLength={2000}
      />
      {error ? <ErrorBox message={error} /> : null}
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Sending…" : isDispute ? "Raise payment dispute" : "Report incident"}
        </button>
      </div>
    </form>
  );
}

/** Change-password form — the existing changePasswordAction; errors
 *  from the service (wrong current password, reused password, too
 *  short) come back as the action's error string and are shown inline. */
export function ChangePasswordForm() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (newPassword !== confirmPassword) {
      setError("The new password and its confirmation do not match.");
      return;
    }
    setBusy(true);
    const result = await changePasswordAction({ currentPassword, newPassword });
    setBusy(false);
    if (!result.success) {
      setError(result.error ?? "Something went wrong");
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setNotice("Password changed. Your other signed-in sessions have been signed out.");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid max-w-md gap-3">
      <TextInput
        id="current-password"
        label="Current password"
        type="password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        required
      />
      <TextInput
        id="new-password"
        label="New password"
        type="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        required
        minLength={10}
        hint="At least 10 characters, and different from your current password."
        error={
          confirmPassword && newPassword !== confirmPassword
            ? "The new password and its confirmation do not match."
            : undefined
        }
      />
      <TextInput
        id="confirm-password"
        label="Confirm new password"
        type="password"
        autoComplete="new-password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        required
      />
      {error ? <ErrorBox message={error} /> : null}
      {notice ? (
        <div className="rounded-md border border-line bg-greenbg px-3 py-2 text-[13px] text-greendeep">
          {notice}
        </div>
      ) : null}
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Changing…" : "Change password"}
        </button>
      </div>
    </form>
  );
}
