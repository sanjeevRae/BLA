import Link from "next/link";

import type { ActorContext } from "@/lib/auth/actor";
import { getCustomer, listCustomerAddresses, listCustomers } from "@/server/services/customers";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";
import { formatDateTime } from "@/components/bookings/ui";
import {
  CustomerAddressForm,
  CustomerForm,
  MergeCustomerForm,
} from "@/components/customers/forms";

/** Customer module pages for the Admin / Super Admin groups. All data
 *  through CustomerService (permission-checked). */

export async function CustomersListPage({
  actor,
  basePath,
  page,
  search,
}: {
  actor: ActorContext;
  basePath: string;
  page: number;
  search?: string;
}) {
  const { customers, meta } = await listCustomers(actor, { page, pageSize: 20, search });
  const canManage = actor.permissions.has("customer.manage");
  return (
    <div className="grid gap-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[20px] font-bold text-ink">Customers</h1>
          <p className="text-[13px] text-faint">{meta.total} customer records</p>
        </div>
        {canManage ? (
          <Link href={`${basePath}/customers/new`} className={subtleButtonClass}>
            New customer
          </Link>
        ) : null}
      </div>
      <SectionCard title="Customer records (deduplicated by phone)">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-[0.14em] text-slate2">
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Phone</th>
                <th className="py-2 pr-3">Email</th>
                <th className="py-2 pr-3">Linked account</th>
                <th className="py-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((customer) => (
                <tr key={customer.id} className="border-b border-line/60">
                  <td className="py-2 pr-3">
                    <Link href={`${basePath}/customers/${customer.id}`} className="font-semibold text-brand">
                      {customer.fullName}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 text-ink">{customer.phone}</td>
                  <td className="py-2 pr-3 text-ink">{customer.email ?? "—"}</td>
                  <td className="py-2 pr-3 text-ink">{customer.userId ? "Yes" : "No"}</td>
                  <td className="py-2 text-faint">{formatDateTime(customer.createdAt)}</td>
                </tr>
              ))}
              {customers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-4 text-faint">
                    No customers found.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {meta.totalPages > 1 ? (
          <div className="mt-3 flex gap-2">
            {page > 1 ? (
              <Link href={`${basePath}/customers?page=${page - 1}`} className={subtleButtonClass}>
                Previous
              </Link>
            ) : null}
            {page < meta.totalPages ? (
              <Link href={`${basePath}/customers?page=${page + 1}`} className={subtleButtonClass}>
                Next
              </Link>
            ) : null}
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}

export async function CustomerDetailPage({
  actor,
  basePath,
  customerId,
}: {
  actor: ActorContext;
  basePath: string;
  customerId: string;
}) {
  const customer = await getCustomer(actor, customerId);
  const addresses = await listCustomerAddresses(actor, customerId);
  const canManage = actor.permissions.has("customer.manage");
  const { customers: others } = canManage
    ? await listCustomers(actor, { page: 1, pageSize: 100 })
    : { customers: [] };
  return (
    <div className="grid gap-5">
      <div>
        <Link href={`${basePath}/customers`} className="text-[12px] font-semibold text-brand">
          ← All customers
        </Link>
        <h1 className="mt-1 text-[20px] font-bold text-ink">{customer.fullName}</h1>
        <p className="text-[13px] text-faint">
          {customer.phone}
          {customer.email ? ` · ${customer.email}` : ""}
          {customer.isMerged ? " · Merged duplicate" : ""}
        </p>
      </div>
      {canManage ? (
        <SectionCard title="Profile">
          <CustomerForm customer={customer} basePath={basePath} />
        </SectionCard>
      ) : null}
      <SectionCard title="Addresses">
        <div className="grid gap-2">
          {addresses.map((address) => (
            <div key={address.id} className="rounded-md border border-line px-3 py-2 text-[13px] text-ink">
              <strong>{address.kind}</strong> — {address.addressLine1}, {address.city},{" "}
              {address.district}
              {address.landmark ? ` · near ${address.landmark}` : ""}
              {address.isDefault ? " · default" : ""}
            </div>
          ))}
          {addresses.length === 0 ? <p className="text-[13px] text-faint">No addresses yet.</p> : null}
        </div>
        {canManage ? (
          <div className="mt-4">
            <CustomerAddressForm customerId={customerId} />
          </div>
        ) : null}
      </SectionCard>
      {canManage && !customer.isMerged ? (
        <SectionCard title="Duplicate resolution">
          <p className="mb-3 text-[13px] text-slate2">
            Merging re-points the duplicate&apos;s packages and bookings to this record and marks
            the duplicate merged — records are never deleted.
          </p>
          <MergeCustomerForm
            winnerId={customerId}
            others={others
              .filter((c) => c.id !== customerId)
              .map((c) => ({ id: c.id, fullName: c.fullName, phone: c.phone }))}
          />
        </SectionCard>
      ) : null}
    </div>
  );
}
