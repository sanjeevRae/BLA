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
  return (
    <div className="grid gap-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[20px] font-bold text-ink">Vendors</h1>
          <p className="text-[13px] text-faint">
            {meta.total} vendor organisation{meta.total === 1 ? "" : "s"}
          </p>
        </div>
        {canManage ? (
          <Link href={`${basePath}/vendors/new`} className={subtleButtonClass}>
            New vendor
          </Link>
        ) : null}
      </div>
      <SectionCard title="Vendor organisations">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-[0.14em] text-slate2">
                <th className="py-2 pr-3">Business</th>
                <th className="py-2 pr-3">Contact</th>
                <th className="py-2 pr-3">Phone</th>
                <th className="py-2 pr-3">Verification</th>
                <th className="py-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((vendor) => (
                <tr key={vendor.id} className="border-b border-line/60">
                  <td className="py-2 pr-3">
                    <Link href={`${basePath}/vendors/${vendor.id}`} className="font-semibold text-brand">
                      {vendor.businessName}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 text-ink">{vendor.contactName}</td>
                  <td className="py-2 pr-3 text-ink">{vendor.phone}</td>
                  <td className="py-2 pr-3">
                    <StatusBadge status={vendor.verificationStatus} />
                  </td>
                  <td className="py-2 text-faint">{formatDateTime(vendor.createdAt)}</td>
                </tr>
              ))}
              {vendors.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-4 text-faint">
                    No vendors found.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {meta.totalPages > 1 ? (
          <div className="mt-3 flex gap-2">
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
      </SectionCard>
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
        <Link href={`${basePath}/vendors`} className="text-[12px] font-semibold text-brand">
          ← All vendors
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-[20px] font-bold text-ink">{vendor.businessName}</h1>
          <StatusBadge status={vendor.verificationStatus} />
        </div>
        <p className="text-[13px] text-faint">
          {vendor.contactName} · {vendor.phone}
          {vendor.email ? ` · ${vendor.email}` : ""} · Billing: {vendor.billingPreference.replaceAll("_", " ")}
          {vendor.creditLimitPaisa ? ` · Credit limit ${formatPaisa(vendor.creditLimitPaisa)}` : ""}
        </p>
      </div>

      {canApprove ? (
        <SectionCard title="Verification lifecycle">
          <VerificationControls vendor={vendor} />
          {vendor.verificationNotes ? (
            <p className="mt-2 text-[13px] text-slate2">{vendor.verificationNotes}</p>
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
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
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
          {addresses.length === 0 ? <p className="text-[13px] text-faint">No addresses yet.</p> : null}
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
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
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
            <p className="text-[13px] text-faint">No document records yet.</p>
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
            <div key={user.id} className="rounded-md border border-line px-3 py-2 text-[13px] text-ink">
              <strong>{user.fullName}</strong> — {user.email} · {user.vendorRole}
              {user.isActive ? "" : " (inactive)"}
            </div>
          ))}
          {users.length === 0 ? <p className="text-[13px] text-faint">No vendor users yet.</p> : null}
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
            <div key={assignment.id} className="rounded-md border border-line px-3 py-2 text-[13px] text-ink">
              {assignment.kind} — {assignment.warehouseCode}
              {assignment.isActive ? "" : " (inactive)"}
            </div>
          ))}
          {assignments.length === 0 ? (
            <p className="text-[13px] text-faint">No warehouse assigned.</p>
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
