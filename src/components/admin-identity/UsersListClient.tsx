"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { DataTable } from "@/components/ui/DataTable";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ROLE_CODES } from "@/lib/permissions/catalog";
import type { ListUsersResult } from "@/server/services/users";
import { formatDateTime, roleLabel } from "./ui";

/**
 * Users list (Phase 6): server-driven search / role / status filters
 * and pagination — every change round-trips through the URL so the
 * page stays a thin server component and the service re-checks
 * user.manage on each render.
 */
export function UsersListClient({
  basePath,
  result,
  initialSearch,
  initialRole,
  initialStatus,
}: {
  basePath: string;
  result: ListUsersResult;
  initialSearch: string;
  initialRole: string;
  initialStatus: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(initialSearch);
  const firstRender = useRef(true);

  function navigate(next: { search?: string; role?: string; status?: string; page?: number }) {
    const params = new URLSearchParams();
    const searchValue = next.search ?? search;
    const roleValue = next.role ?? initialRole;
    const statusValue = next.status ?? initialStatus;
    if (searchValue) params.set("search", searchValue);
    if (roleValue) params.set("role", roleValue);
    if (statusValue) params.set("status", statusValue);
    if (next.page && next.page > 1) params.set("page", String(next.page));
    const qs = params.toString();
    router.push(qs ? `${basePath}/users?${qs}` : `${basePath}/users`);
  }

  // Debounced search: typing updates the box immediately and the URL
  // (hence the server query) after a short pause.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const handle = setTimeout(() => navigate({ search, page: 1 }), 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const selectClass =
    "min-h-[44px] rounded-md border border-line bg-surface px-3 text-[13px] text-ink";

  return (
    <DataTable
      ariaLabel="Users"
      rows={result.items}
      rowKey={(row) => row.id}
      search={{
        value: search,
        onChange: setSearch,
        placeholder: "Search name or email",
      }}
      filters={
        <>
          <select
            aria-label="Filter by role"
            className={selectClass}
            value={initialRole}
            onChange={(event) => navigate({ role: event.target.value, page: 1 })}
          >
            <option value="">All roles</option>
            {ROLE_CODES.map((code) => (
              <option key={code} value={code}>
                {roleLabel(code)}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by status"
            className={selectClass}
            value={initialStatus}
            onChange={(event) => navigate({ status: event.target.value, page: 1 })}
          >
            <option value="">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="SUSPENDED">Suspended</option>
            <option value="DEACTIVATED">Deactivated</option>
          </select>
        </>
      }
      pagination={{
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        onPageChange: (page) => navigate({ page }),
      }}
      emptyState={
        <div className="py-6 text-center">
          <p className="text-[14px] font-semibold text-ink">No users match</p>
          <p className="mt-1 text-[13px] text-slate2">
            No user accounts match the current search and filters. Invited users appear here once
            they accept their invitation.
          </p>
        </div>
      }
      columns={[
        {
          key: "fullName",
          header: "User",
          render: (row) => (
            <div className="leading-tight">
              <Link href={`${basePath}/users/${row.id}`} className="font-semibold text-brand">
                {row.fullName}
              </Link>
              <div className="text-[12px] text-slate2">{row.email}</div>
            </div>
          ),
        },
        {
          key: "status",
          header: "Status",
          render: (row) => <StatusBadge domain="generic" status={row.status} />,
        },
        {
          key: "roles",
          header: "Roles",
          render: (row) => (
            <div className="flex flex-wrap gap-1">
              {row.roles.length === 0 ? (
                <span className="text-slate2">—</span>
              ) : (
                row.roles.map((code) => (
                  <span
                    key={code}
                    className="rounded-md bg-accentbg px-2 py-0.5 text-[11px] font-semibold text-brand"
                  >
                    {roleLabel(code)}
                  </span>
                ))
              )}
            </div>
          ),
        },
        {
          key: "memberships",
          header: "Warehouses",
          render: (row) =>
            row.memberships.length === 0 ? (
              <span className="text-slate2">—</span>
            ) : (
              <span className="text-slate2">
                {row.memberships.map((m) => m.warehouseCode).join(", ")}
              </span>
            ),
        },
        {
          key: "mfaEnrolled",
          header: "MFA",
          render: (row) => (row.mfaEnrolled ? "Enrolled" : "Not enrolled"),
        },
        {
          key: "createdAt",
          header: "Created",
          render: (row) => formatDateTime(row.createdAt),
        },
      ]}
    />
  );
}
