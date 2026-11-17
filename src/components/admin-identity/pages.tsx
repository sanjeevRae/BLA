import Link from "next/link";
import { notFound } from "next/navigation";

import { hasPermission, type ActorContext } from "@/lib/auth/actor";
import { NotFoundError } from "@/lib/errors";
import { listAuditLogs } from "@/server/services/audit-log";
import { listInvitations } from "@/server/services/invitations";
import { listSettings } from "@/server/services/system-settings";
import { getUserDetail, listUsers } from "@/server/services/users";
import { listVendors } from "@/server/services/vendors";
import { listWarehouseDirectory, listWarehouses } from "@/server/services/warehouses";
import { AuditListClient } from "./AuditListClient";
import { InvitePanel } from "./InvitePanel";
import { SettingsEditor } from "./SettingsEditor";
import {
  RolesEditor,
  UserAccountActions,
  UserIdentityCard,
  UserMembershipsPanel,
} from "./UserDetailPanels";
import { UsersListClient } from "./UsersListClient";
import { PageHeader } from "@/components/ui/PageHeader";

/**
 * Super Admin / Admin identity surfaces (Phase 6, audit H-4). Thin
 * server components: the actor comes from the dashboard layout's
 * requireActor, every read goes through a permission-gated service,
 * and the interactive parts are the client components alongside.
 */

export async function UsersListPage({
  actor,
  basePath,
  query,
}: {
  actor: ActorContext;
  basePath: string;
  query: { search?: string; role?: string; status?: string; page?: string };
}) {
  const page = Number(query.page ?? 1) || 1;
  const result = await listUsers(actor, {
    search: query.search,
    roleCode: query.role,
    status: query.status,
    page,
    pageSize: 25,
  });

  const canInvite = hasPermission(actor, "user.invite");
  let invitePanel = null;
  if (canInvite) {
    const [queue, pending, warehouses, vendorResult] = await Promise.all([
      listInvitations(actor, { status: "PENDING_APPROVAL", pageSize: 100 }),
      listInvitations(actor, { status: "PENDING", pageSize: 100 }),
      listWarehouseDirectory(),
      listVendors(actor, { pageSize: 100 }).catch(() => ({ vendors: [] as { id: string; businessName: string }[] })),
    ]);
    invitePanel = (
      <InvitePanel
        currentUserId={actor.userId}
        queue={queue.items}
        pending={pending.items}
        warehouses={warehouses}
        vendors={vendorResult.vendors.map((v) => ({ id: v.id, businessName: v.businessName }))}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Administration"
        title="Users & Roles"
        description={`${result.total} user account${result.total === 1 ? "" : "s"}`}
      />
      <UsersListClient
        basePath={basePath}
        result={result}
        initialSearch={query.search ?? ""}
        initialRole={query.role ?? ""}
        initialStatus={query.status ?? ""}
      />
      {invitePanel}
    </div>
  );
}

export async function UserDetailPage({
  actor,
  basePath,
  userId,
}: {
  actor: ActorContext;
  basePath: string;
  userId: string;
}) {
  let user;
  try {
    user = await getUserDetail(actor, userId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const warehouses = await listWarehouses(actor, { pageSize: 100 })
    .then((r) => r.items.map((w) => ({ id: w.id, code: w.code, name: w.name })))
    .catch(() => [] as { id: string; code: string; name: string }[]);
  const canManageRoles = hasPermission(actor, "role.manage");
  const canAssign = hasPermission(actor, "warehouse.assign_staff");
  const isSelf = actor.userId === user.id;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href={`${basePath}/users`} className="text-[12px] font-semibold text-primary">
          ← All users
        </Link>
        <PageHeader title={user.fullName} description={user.email} className="mt-1" />
      </div>
      <UserIdentityCard user={user} />
      <RolesEditor user={user} canManage={canManageRoles && !isSelf} />
      {isSelf && canManageRoles ? (
        <p className="-mt-2 text-[12px] text-ink-2">
          You cannot change your own roles — another Super Admin must do it.
        </p>
      ) : null}
      <UserMembershipsPanel user={user} warehouses={warehouses} canAssign={canAssign} />
      <UserAccountActions user={user} isSelf={isSelf} />
    </div>
  );
}

export async function SettingsPage({ actor }: { actor: ActorContext }) {
  const settings = await listSettings(actor);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Administration"
        title="Settings"
        description="Live security and tracking configuration. Changes take effect immediately and are audit-logged."
      />
      <SettingsEditor settings={settings} />
    </div>
  );
}

export async function AuditPage({
  actor,
  basePath,
  query,
}: {
  actor: ActorContext;
  basePath: string;
  query: {
    actor?: string;
    action?: string;
    entityType?: string;
    outcome?: string;
    from?: string;
    to?: string;
    page?: string;
  };
}) {
  const outcome =
    query.outcome === "denied" || query.outcome === "recorded" ? query.outcome : undefined;
  const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined;
  const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined;
  const result = await listAuditLogs(actor, {
    actorSearch: query.actor,
    action: query.action,
    entityType: query.entityType,
    outcome,
    from: from && !Number.isNaN(from.getTime()) ? from : undefined,
    to: to && !Number.isNaN(to.getTime()) ? to : undefined,
    page: Number(query.page ?? 1) || 1,
    pageSize: 25,
  });
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Administration"
        title="Audit Logs"
        description={`${result.total} entr${result.total === 1 ? "y" : "ies"} — append-only record of sensitive actions and denied access.`}
      />
      <AuditListClient
        basePath={basePath}
        result={result}
        initial={{
          actorSearch: query.actor ?? "",
          action: query.action ?? "",
          entityType: query.entityType ?? "",
          outcome: query.outcome ?? "",
          from: query.from ?? "",
          to: query.to ?? "",
        }}
      />
    </div>
  );
}
