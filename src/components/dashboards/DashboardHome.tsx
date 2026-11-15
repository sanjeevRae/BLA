import type { ActorContext } from "@/lib/auth/actor";

/**
 * Phase 1 placeholder dashboard body: proves the login, the server-side
 * role gate and the actor context end to end. Real module dashboards
 * replace this in their phases (spec Part 27).
 */
export function DashboardHome({
  actor,
  roleLabel,
}: {
  actor: ActorContext;
  roleLabel: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface p-6">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
        Dashboard
      </div>
      <h1 className="mt-1 text-[22px] font-bold text-ink">Welcome, {actor.fullName}</h1>
      <p className="mt-2 max-w-[640px] text-[13px] leading-relaxed text-slate2">
        You are signed in as <strong className="text-ink">{roleLabel}</strong>. This is the
        Phase 1 foundation: secure login, database sessions and server-side role and
        permission checks are live. The operational modules for this role arrive in the
        later build phases.
      </p>
      <dl className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-md border border-line bg-page px-4 py-3">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">Roles</dt>
          <dd className="mt-1 text-[13px] font-medium text-ink">{actor.roles.join(", ") || "—"}</dd>
        </div>
        <div className="rounded-md border border-line bg-page px-4 py-3">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">Permissions</dt>
          <dd className="tnum mt-1 text-[13px] font-medium text-ink">{actor.permissions.size} granted</dd>
        </div>
        <div className="rounded-md border border-line bg-page px-4 py-3">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
            Warehouse memberships
          </dt>
          <dd className="tnum mt-1 text-[13px] font-medium text-ink">{actor.warehouseIds.length}</dd>
        </div>
      </dl>
    </div>
  );
}
