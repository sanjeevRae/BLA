import Link from "next/link";

import type { ActorContext } from "@/lib/auth/actor";
import { getCustomer, listCustomerAddresses, listCustomers } from "@/server/services/customers";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";
import { formatDateTime } from "@/components/bookings/ui";
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

/** DS §7.3 primary Link-button class (same class the dashboards use). */
const primaryLinkClass =
  "inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-[14px] font-[550] text-white hover:bg-primary-dark";
/** TD_CLASS with the meta ink (timestamps, DS §3) swapped in. */
const tdMetaClass = "px-3 py-2 text-table text-ink-2";
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
  // No FilterBar: this page honours only `page` and `search` (a form
  // behaviour), and no filter form exists in its route pages.
  return (
    <div className="grid gap-5">
      <PageHeader
        title="Customers"
        description={`${meta.total} customer records`}
        actions={
          canManage ? (
            <Link href={`${basePath}/customers/new`} className={primaryLinkClass}>
              New customer
            </Link>
          ) : undefined
        }
      />
      {customers.length === 0 ? (
        <EmptyState title="No customers found." />
      ) : (
        <DensityScope showToggle>
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS}>
              <thead>
                <tr className={THEAD_ROW_CLASS}>
                  <th className={`${TH_CLASS} text-left`}>Name</th>
                  <th className={`${TH_CLASS} text-left`}>Phone</th>
                  <th className={`${TH_CLASS} text-left`}>Email</th>
                  <th className={`${TH_CLASS} text-left`}>Linked account</th>
                  <th className={`${TH_CLASS} text-left`}>Created</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.id} className={TR_CLASS}>
                    <td className={TD_CLASS}>
                      <Link
                        href={`${basePath}/customers/${customer.id}`}
                        className="font-semibold text-primary"
                      >
                        {customer.fullName}
                      </Link>
                    </td>
                    <td className={TD_CLASS}>{customer.phone}</td>
                    <td className={TD_CLASS}>{customer.email ?? "—"}</td>
                    <td className={TD_CLASS}>{customer.userId ? "Yes" : "No"}</td>
                    <td className={tdMetaClass}>{formatDateTime(customer.createdAt)}</td>
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
