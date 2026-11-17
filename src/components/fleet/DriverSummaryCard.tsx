import type { ReactNode } from "react";

import type { DriverProfileView } from "@/server/services/drivers";
import { SectionCard } from "@/components/warehouses/ui";
import { StatusBadge } from "@/components/ui/StatusBadge";

/**
 * DriverSummaryCard (V3 Step 9, DS §10) — an additive summary at the
 * top of the driver detail page, composed ONLY from the base
 * DriverProfileView fields the detail page already renders.
 *
 * Field map (explicit — the prop type is a Pick<> of exactly these
 * fields, so nothing else can be read):
 *   fullName, email, phone,
 *   homeWarehouse { code, name },
 *   roles, capabilities,
 *   employmentStatus, availabilityStatus,
 *   licenseNumber, licenseCategory, licenseExpiry, licenseExpired,
 *   emergencyContactName, emergencyContactPhone,
 *   userStatus,
 *   currentVehicle { registration, type, status } | null
 *
 * The permission-scoped `gps` key is deliberately NOT in the Pick<>:
 * a profile carrying it and a profile without it both typecheck
 * against this card, and the card can never render (or leak the
 * presence of) the GPS snapshot. Statuses render through the shared
 * StatusBadge (generic domain) — words only change, never logic.
 */
export type DriverSummaryProfile = Pick<
  DriverProfileView,
  | "fullName"
  | "email"
  | "phone"
  | "homeWarehouse"
  | "roles"
  | "capabilities"
  | "employmentStatus"
  | "availabilityStatus"
  | "licenseNumber"
  | "licenseCategory"
  | "licenseExpiry"
  | "licenseExpired"
  | "emergencyContactName"
  | "emergencyContactPhone"
  | "userStatus"
  | "currentVehicle"
>;

function SummaryField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <dt className="text-ink-2">{label}</dt>
      <dd className="font-medium text-ink">{children}</dd>
    </div>
  );
}

export function DriverSummaryCard({ profile }: { profile: DriverSummaryProfile }) {
  return (
    <SectionCard title="Driver summary">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[15px] font-semibold text-ink">{profile.fullName}</div>
          <div className="text-[12.5px] text-ink-2">
            {profile.email}
            {profile.phone ? ` · ${profile.phone}` : ""} · home{" "}
            {profile.homeWarehouse.code} — {profile.homeWarehouse.name}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge domain="generic" status={profile.employmentStatus} />
          <StatusBadge domain="generic" status={profile.availabilityStatus} />
          <StatusBadge domain="generic" status={profile.userStatus} />
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
        <SummaryField label="Type">{profile.roles.join(", ") || "—"}</SummaryField>
        <SummaryField label="Capabilities">
          {profile.capabilities.join(", ") || "—"}
        </SummaryField>
        <SummaryField label="Licence">
          {`${profile.licenseNumber}${profile.licenseCategory ? ` (${profile.licenseCategory})` : ""}`}
        </SummaryField>
        <SummaryField label="Licence expiry">
          {`${profile.licenseExpiry}${profile.licenseExpired ? " — EXPIRED" : ""}`}
        </SummaryField>
        <SummaryField label="Emergency contact">
          {`${profile.emergencyContactName ?? "—"}${profile.emergencyContactPhone ? ` · ${profile.emergencyContactPhone}` : ""}`}
        </SummaryField>
        <SummaryField label="Current vehicle">
          {profile.currentVehicle ? (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <span className="font-mono font-semibold">
                {profile.currentVehicle.registration}
              </span>
              <span>· {profile.currentVehicle.type} ·</span>
              <StatusBadge
                domain="generic"
                status={profile.currentVehicle.status}
                density="compact"
              />
            </span>
          ) : (
            "No vehicle currently assigned."
          )}
        </SummaryField>
      </dl>
    </SectionCard>
  );
}
