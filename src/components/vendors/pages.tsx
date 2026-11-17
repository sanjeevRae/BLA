import Link from "next/link";

import type { ActorContext } from "@/lib/auth/actor";
import {
  getVendor,
  listVendorAddresses,
  listVendorAssignments,
  listVendorDocuments,
  listVendorUsers,
  listVendors,
} from "@/server/services/vendors";
import { listWarehouseDirectory } from "@/server/services/warehouses";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";
import { StatusBadge, formatDateTime, formatPaisa } from "@/components/bookings/ui";
import { FilterBar, FilterChip, FilterClearAll } from "@/components/ui/FilterBar";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/states";
import {
  TABLE_CLASS,
  TD_CLASS,
  THEAD_ROW_CLASS,
  TH_CLASS,
  TR_CLASS,
} from "@/components/ui/table-chrome";
import { DensityScope } from "@/components/ui/TableDensity";
import { VENDOR_VERIFICATION_STATUSES } from "@/lib/bookings/domain";
import { statusLabel } from "@/lib/status/labels";

/** DS §7.3 primary Link-button class (same class the dashboards use). */
const primaryLinkClass =
  "inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-[14px] font-[550] text-white hover:bg-primary-dark";
/** TD_CLASS with the meta ink (timestamps, DS §3) swapped in. */
const tdMetaClass = "px-3 py-2 text-table text-ink-2";
import {
  ApproveAddressButton,
  ReviewDocumentButtons,
  VendorAddressForm,
  VendorAssignmentForm,
  VendorDocumentForm,
  VendorForm,
  VendorInviteForm,
  VerificationControls,
} from "@/components/vendors/forms";

/** Vendor module pages, shared by the Admin and Super Admin groups
 *  (basePath differs) and — for the detail view — the vendor's own
 *  profile page. All data comes through VendorService, which enforces
 *  permissions and vendor self-scoping. */

export async function VendorsListPage({
  actor,
  basePath,
  page,
  search,
  status,
}: {
  actor: ActorContext;
  basePath: string;
  page: number;
  search?: string;
  status?: string;
}) {
  const { vendors, meta } = await listVendors(actor, { page, pageSize: 20, search, status });
  const canManage = actor.permissions.has("vendor.manage");
  // Filter chips (DS §7.7) for the one filter param this page honours:
  // `status`, which listVendors applies to verificationStatus. Values
  // are the service's own vocabulary; `search` is preserved as-is.
  const statusHref = (value: string) => {
    const params = new URLSearchParams();
    params.set("status", value);
    if (search) params.set("search", search);
    return `${basePath}/vendors?${params.toString()}`;
  };
  return (
    <div className="grid gap-5">
      <PageHeader
        title="Vendors"
        description={`${meta.total} vendor organisation${meta.total === 1 ? "" : "s"}`}
        actions={
          canManage ? (
            <Link href={`${basePath}/vendors/new`} className={primaryLinkClass}>
              New vendor
            </Link>
          ) : undefined
        }
      />
      <FilterBar ariaLabel="Vendor verification filters">
        {VENDOR_VERIFICATION_STATUSES.map((value) => (
          <FilterChip key={value} href={statusHref(value)} active={status === value}>
            {statusLabel("generic", value)}
          </FilterChip>
        ))}
        {status ? <FilterClearAll href={`${basePath}/vendors`} /> : null}
      </FilterBar>
      {vendors.length === 0 ? (
        <EmptyState title="No vendors found." />
      ) : (
        <DensityScope showToggle>
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className={TABLE_CLASS}>
              <thead>
                <tr className={THEAD_ROW_CLASS}>
                  <th className={`${TH_CLASS} text-left`}>Business</th>
                  <th className={`${TH_CLASS} text-left`}>Contact</th>
                  <th className={`${TH_CLASS} text-left`}>Phone</th>
                  <th className={`${TH_CLASS} text-left`}>Verification</th>
                  <th className={`${TH_CLASS} text-left`}>Created</th>
                </tr>
              </thead>
              <tbody>
                {vendors.map((vendor) => (
                  <tr key={vendor.id} className={TR_CLASS}>
                    <td className={TD_CLASS}>
                      <Link
                        href={`${basePath}/vendors/${vendor.id}`}
                        className="font-semibold text-primary"
                      >
                        {vendor.businessName}
                      </Link>
                    </td>
                    <td className={TD_CLASS}>{vendor.contactName}</td>
                    <td className={TD_CLASS}>{vendor.phone}</td>
                    <td className={TD_CLASS}>
                      <StatusBadge status={vendor.verificationStatus} />
                    </td>
                    <td className={tdMetaClass}>{formatDateTime(vendor.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DensityScope>
      )}
      {meta.totalPages > 1 ? (
        <div className="flex gap-2">
          {page > 1 ? (
            <Link href={`${basePath}/vendors?page=${page - 1}`} className={subtleButtonClass}>
              Previous
            </Link>
          ) : null}
          {page < meta.totalPages ? (
            <Link href={`${basePath}/vendors?page=${page + 1}`} className={subtleButtonClass}>
              Next
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export async function VendorDetailPage({
  actor,
  basePath,
  vendorId,
}: {
  actor: ActorContext;
  basePath: string;
  vendorId: string;
}) {
  const vendor = await getVendor(actor, vendorId);
  const [addresses, documents, users, assignments, warehouses] = await Promise.all([
    listVendorAddresses(actor, vendorId),
    listVendorDocuments(actor, vendorId),
    listVendorUsers(actor, vendorId),
    listVendorAssignments(actor, vendorId),
    listWarehouseDirectory(),
  ]);
  const canManage = actor.permissions.has("vendor.manage");
  const canApprove = actor.permissions.has("vendor.approve");
  const isOwnVendor = actor.vendorId === vendorId;
  const canSelfManage =
    isOwnVendor && actor.vendorRole != null && ["OWNER", "MANAGER"].includes(actor.vendorRole);

  return (
    <div className="grid gap-5">
      <div>
        <Link href={`${basePath}/vendors`} className="text-[12px] font-semibold text-primary">
          ← All vendors
        </Link>
        <PageHeader
          title={vendor.businessName}
          description={
            <>
              {vendor.contactName} · {vendor.phone}
              {vendor.email ? ` · ${vendor.email}` : ""} · Billing: {vendor.billingPreference.replaceAll("_", " ")}
              {vendor.creditLimitPaisa ? ` · Credit limit ${formatPaisa(vendor.creditLimitPaisa)}` : ""}
            </>
          }
          actions={<StatusBadge status={vendor.verificationStatus} />}
          className="mt-1"
        />
      </div>

      {canApprove ? (
        <SectionCard title="Verification lifecycle">
          <VerificationControls vendor={vendor} />
          {vendor.verificationNotes ? (
            <p className="mt-2 text-[13px] text-ink-2">{vendor.verificationNotes}</p>
          ) : null}
        </SectionCard>
      ) : null}

      {canManage ? (
        <SectionCard title="Profile">
          <VendorForm vendor={vendor} basePath={basePath} />
        </SectionCard>
      ) : null}

      <SectionCard title="Addresses">
        <div className="grid gap-2">
          {addresses.map((address) => (
            <div
              key={address.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-[13px]"
            >
              <span className="text-ink">
                <strong>{address.kind}</strong> — {address.addressLine1}, {address.city},{" "}
                {address.district}
              </span>
              <span className="flex items-center gap-2">
                <StatusBadge status={address.isApproved ? "APPROVED" : "PENDING"} />
                {canManage && !address.isApproved ? (
                  <ApproveAddressButton vendorId={vendorId} addressId={address.id} />
                ) : null}
              </span>
            </div>
          ))}
          {addresses.length === 0 ? <p className="text-[13px] text-ink-2">No addresses yet.</p> : null}
        </div>
        {canManage || canSelfManage ? (
          <div className="mt-4">
            <VendorAddressForm vendorId={vendorId} canApprove={canManage} />
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title="Verification documents">
        <div className="grid gap-2">
          {documents.map((doc) => (
            <div
              key={doc.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-[13px]"
            >
              <span className="text-ink">
                <strong>{doc.documentType}</strong> — {doc.fileName}
              </span>
              <span className="flex items-center gap-2">
                <StatusBadge status={doc.status} />
                {canApprove && doc.status === "PENDING_REVIEW" ? (
                  <ReviewDocumentButtons vendorId={vendorId} documentId={doc.id} />
                ) : null}
              </span>
            </div>
          ))}
          {documents.length === 0 ? (
            <p className="text-[13px] text-ink-2">No document records yet.</p>
          ) : null}
        </div>
        {canManage || canSelfManage ? (
          <div className="mt-4">
            <VendorDocumentForm vendorId={vendorId} />
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title="Team">
        <div className="grid gap-2">
          {users.map((user) => (
            <div key={user.id} className="rounded-md border border-border px-3 py-2 text-[13px] text-ink">
              <strong>{user.fullName}</strong> — {user.email} · {user.vendorRole}
              {user.isActive ? "" : " (inactive)"}
            </div>
          ))}
          {users.length === 0 ? <p className="text-[13px] text-ink-2">No vendor users yet.</p> : null}
        </div>
        {canManage || (isOwnVendor && actor.vendorRole === "OWNER") ? (
          <div className="mt-4">
            <VendorInviteForm vendorId={vendorId} />
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title="Warehouse assignments">
        <div className="grid gap-2">
          {assignments.map((assignment) => (
            <div key={assignment.id} className="rounded-md border border-border px-3 py-2 text-[13px] text-ink">
              {assignment.kind} — {assignment.warehouseCode}
              {assignment.isActive ? "" : " (inactive)"}
            </div>
          ))}
          {assignments.length === 0 ? (
            <p className="text-[13px] text-ink-2">No warehouse assigned.</p>
          ) : null}
        </div>
        {canManage ? (
          <div className="mt-4">
            <VendorAssignmentForm vendorId={vendorId} warehouses={warehouses} />
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}
