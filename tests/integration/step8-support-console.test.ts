import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Step 8 (V3) — Support console read model against bla_test:
 *  - unequal planted fixtures (open unassigned HIGH, open
 *    assigned-to-me URGENT, open NORMAL assigned to someone else,
 *    an old >48h open ticket, a RESOLVED ticket; an open incident
 *    in support scope; tasks assigned to the actor: overdue, due
 *    today, future, CLOSED);
 *  - every card figure equals service truth: attention / queues /
 *    open incidents equal getSupportHome, the queue rows and My
 *    tickets equal listTickets with the same filters,
 *    highPriorityOpen equals an independent DB count, and
 *    tasksDue / tasksOverdue / myTasks equal an in-test computation
 *    from listTasks output;
 *  - MONEY BOUNDARY: no KEY of the serialised model, at any depth,
 *    matches /paisa|amount|price|cod|invoice|payment|revenue/i
 *    (the boundary is about figures the surface itself surfaces —
 *    keys, not free-text values planted by other suites);
 *  - a vendor actor (no support.ticket.manage) is refused.
 */

function loadEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const email = (label: string) => `s8s-${label}-${RUN}@bla.test`;

let prisma: import("@prisma/client").PrismaClient;
let supportHomeSvc: typeof import("@/server/services/support-home");
let ticketsSvc: typeof import("@/server/services/support-tickets");
let tasksSvc: typeof import("@/server/services/tasks");
let reportsDomain: typeof import("@/lib/reports/domain");
let opsDomain: typeof import("@/lib/operations/domain");
let catalog: typeof import("@/lib/permissions/catalog");

type Actor = Awaited<ReturnType<typeof actorFor>>;

const fx: Record<string, string> = {};
let supportActor: Actor;
let vendorActor: Actor;

async function actorFor(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: {
        include: {
          role: { include: { permissions: { include: { permission: true } } } },
        },
      },
      memberships: { where: { revokedAt: null }, include: { role: true } },
    },
  });
  if (!user) throw new Error("fixture user missing");
  const roles: string[] = [];
  const permissions = new Set<string>();
  for (const userRole of user.roles) {
    if (!userRole.role.isActive) continue;
    roles.push(userRole.role.code);
    for (const rp of userRole.role.permissions) permissions.add(rp.permission.code);
  }
  const [vendorLink, customerProfile, driverProfile] = await Promise.all([
    prisma.vendorUser.findFirst({
      where: { userId: user.id, isActive: true, vendor: { isActive: true } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.customer.findUnique({ where: { userId: user.id } }),
    prisma.driver.findUnique({ where: { userId: user.id }, select: { id: true } }),
  ]);
  return {
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    roles: roles as never[],
    primaryRole: catalog.primaryRoleFor(roles as never[]),
    permissions,
    warehouseIds: user.memberships.map((m) => m.warehouseId),
    membershipRoles: user.memberships.map((m) => ({
      warehouseId: m.warehouseId,
      roleCode: m.role.code as never,
    })),
    vendorId: vendorLink?.vendorId ?? null,
    vendorRole: vendorLink?.vendorRole ?? null,
    driverId: driverProfile?.id ?? null,
    customerId: customerProfile?.id ?? null,
    landingPath: catalog.landingPathForRoles(roles as never[]),
  };
}

async function makeUser(label: string, roleCode: string): Promise<string> {
  const { hash } = await import("bcryptjs");
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: `S8S ${label}`,
      passwordHash: await hash("Fixture#2026", 10),
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    },
  });
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  if (!role) throw new Error(`role missing: ${roleCode}`);
  await prisma.userRole.create({
    data: { userId: user.id, roleId: role.id, assignedById: fx.adminUser ?? user.id },
  });
  return user.id;
}

async function makeTicket(input: {
  label: string;
  status: string;
  priority: string;
  assignedToId?: string | null;
  createdAt?: Date;
}): Promise<string> {
  const ticket = await prisma.supportTicket.create({
    data: {
      ticketNumber: `TKT-S8S-${input.label}-${RUN}`,
      category: "GENERAL",
      status: input.status,
      priority: input.priority,
      subject: `S8S ticket ${input.label} ${RUN}`,
      description: `Planted ticket ${input.label}`,
      raisedById: fx.raiserUser,
      assignedToId: input.assignedToId ?? null,
      createdAt: input.createdAt,
      resolvedAt: input.status === "RESOLVED" ? new Date() : null,
    },
  });
  return ticket.id;
}

async function makeTask(input: {
  label: string;
  status: string;
  dueAt: Date | null;
}): Promise<string> {
  const task = await prisma.task.create({
    data: {
      title: `S8S task ${input.label} ${RUN}`,
      createdById: fx.adminUser,
      assigneeId: fx.supportUser,
      status: input.status,
      priority: "NORMAL",
      dueAt: input.dueAt,
    },
  });
  fx[`task-${input.label}`] = task.id;
  return task.id;
}

/** Recursively collect every object key in the model. */
function allKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      into.push(key);
      allKeys(nested, into);
    }
  }
  return into;
}

beforeAll(async () => {
  const root = process.cwd();
  const env = {
    ...loadEnvFile(join(root, "prisma/.env")),
    ...loadEnvFile(join(root, ".env.local")),
  };
  const url = env.DATABASE_URL ?? "";
  if (!url.includes("/bla_dev")) throw new Error("Expected the bla_dev DATABASE_URL");
  process.env.DATABASE_URL = url.replace("/bla_dev", "/bla_test");

  const clientModule = await import("@prisma/client");
  prisma = new clientModule.PrismaClient();
  supportHomeSvc = await import("@/server/services/support-home");
  ticketsSvc = await import("@/server/services/support-tickets");
  tasksSvc = await import("@/server/services/tasks");
  reportsDomain = await import("@/lib/reports/domain");
  opsDomain = await import("@/lib/operations/domain");
  catalog = await import("@/lib/permissions/catalog");

  for (const role of catalog.ROLES) {
    await prisma.role.upsert({
      where: { code: role.code },
      update: { name: role.name, isActive: true },
      create: { code: role.code, name: role.name, description: role.description, isSystem: true },
    });
  }
  for (const permission of catalog.PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { name: permission.name, module: permission.module },
      create: { code: permission.code, name: permission.name, module: permission.module },
    });
  }
  const roleRows = await prisma.role.findMany();
  const permissionRows = await prisma.permission.findMany();
  const roleId = new Map(roleRows.map((r) => [r.code, r.id]));
  const permissionId = new Map(permissionRows.map((p) => [p.code, p.id]));
  for (const role of catalog.ROLES) {
    for (const code of catalog.ROLE_PERMISSIONS[role.code]) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: roleId.get(role.code)!,
            permissionId: permissionId.get(code)!,
          },
        },
        update: {},
        create: { roleId: roleId.get(role.code)!, permissionId: permissionId.get(code)! },
      });
    }
  }

  fx.adminUser = await makeUser("admin", "ADMIN");
  fx.supportUser = await makeUser("support", "SUPPORT");
  fx.otherUser = await makeUser("other", "SUPPORT");
  fx.raiserUser = await makeUser("raiser", "CUSTOMER");
  fx.vendorUser = await makeUser("vendor", "VENDOR");
  supportActor = await actorFor(fx.supportUser);
  vendorActor = await actorFor(fx.vendorUser);

  // Tickets — unequal fixtures. Subjects carry no money strings.
  fx.tUnassignedHigh = await makeTicket({ label: "UH", status: "OPEN", priority: "HIGH" });
  fx.tMineUrgent = await makeTicket({
    label: "MU",
    status: "IN_PROGRESS",
    priority: "URGENT",
    assignedToId: fx.supportUser,
  });
  fx.tOtherNormal = await makeTicket({
    label: "ON",
    status: "OPEN",
    priority: "NORMAL",
    assignedToId: fx.otherUser,
  });
  fx.tOld = await makeTicket({
    label: "OLD",
    status: "OPEN",
    priority: "NORMAL",
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
  });
  fx.tResolved = await makeTicket({
    label: "RES",
    status: "RESOLVED",
    priority: "HIGH",
    assignedToId: fx.supportUser,
  });

  // One open incident in the support scope (customer-facing category).
  const incident = await prisma.incident.create({
    data: {
      incidentNumber: `INC-S8S-${RUN}`,
      category: "CUSTOMER_COMPLAINT",
      severity: "HIGH",
      status: "REPORTED",
      description: `S8S planted incident ${RUN}`,
      reporterId: fx.supportUser,
    },
  });
  fx.incident = incident.id;

  // Tasks assigned to the support actor.
  const now = Date.now();
  await makeTask({ label: "overdue", status: "ASSIGNED", dueAt: new Date(now - 26 * 60 * 60 * 1000) });
  await makeTask({ label: "today", status: "IN_PROGRESS", dueAt: new Date(now + 2 * 60 * 60 * 1000) });
  await makeTask({ label: "future", status: "ASSIGNED", dueAt: new Date(now + 3 * 24 * 60 * 60 * 1000) });
  await makeTask({ label: "closed", status: "CLOSED", dueAt: new Date(now - 2 * 24 * 60 * 60 * 1000) });
}, 120_000);

describe("Step 8 — support console model", () => {
  it("attention, queues and open incidents equal getSupportHome exactly", async () => {
    const model = await supportHomeSvc.getSupportConsole(supportActor);
    const home = await supportHomeSvc.getSupportHome(supportActor);
    expect(model.today).toBe(home.today);
    expect(model.attention).toEqual(home.attention);
    expect(model.queues).toEqual(home.queues);
    expect(model.openIncidents).toBe(home.metrics.openIncidents);
    expect(model.oldestOpenTickets).toEqual(home.oldestOpenTickets);
    expect(model.overdueDeliveryItems).toEqual(home.overdueDeliveryItems);
    expect(model.recentTickets).toEqual(home.recentTickets);
    expect(model.recentIncidents).toEqual(home.recentIncidents);
    // The planted fixtures are visible in the home truth.
    expect(home.attention.unassignedTickets).toBeGreaterThanOrEqual(2);
    expect(home.attention.breachingTickets).toBeGreaterThanOrEqual(1);
    expect(home.metrics.openIncidents).toBeGreaterThanOrEqual(1);
  });

  it("queue rows and My tickets equal listTickets with the same filters", async () => {
    const model = await supportHomeSvc.getSupportConsole(supportActor);
    const queue = await ticketsSvc.listTickets(supportActor, { openOnly: true, pageSize: 10 });
    expect(model.queueTickets).toEqual(
      queue.items.map((item) => ({
        id: item.id,
        ticketNumber: item.ticketNumber,
        subject: item.subject,
        raiserName: item.raiserName,
        priority: item.priority,
        status: item.status,
        assignedToId: item.assignedToId,
        assigneeName: item.assigneeName,
        createdAt: item.createdAt,
      })),
    );
    const mine = await ticketsSvc.listTickets(supportActor, {
      openOnly: true,
      assignedToMe: true,
      pageSize: 1,
    });
    expect(model.myTicketsOpen).toBe(mine.meta.total);
    // Exactly the planted URGENT is mine and open (the RESOLVED one is not).
    expect(mine.meta.total).toBe(1);
    // The resolved HIGH ticket is excluded from the open queue.
    expect(model.queueTickets.map((t) => t.id)).not.toContain(fx.tResolved);
    // The freshly planted rows lead the newest-first queue page;
    // the 3-day-old ticket sits deeper in the shared test DB's
    // history and is covered via the breaching count instead.
    expect(model.queueTickets.map((t) => t.id)).toEqual(
      expect.arrayContaining([fx.tUnassignedHigh, fx.tMineUrgent, fx.tOtherNormal]),
    );
  });

  it("highPriorityOpen equals an independent DB count", async () => {
    const model = await supportHomeSvc.getSupportConsole(supportActor);
    const expected = await prisma.supportTicket.count({
      where: {
        priority: { in: ["HIGH", "URGENT"] },
        status: { in: [...opsDomain.TICKET_OPEN_STATUSES] },
      },
    });
    expect(model.highPriorityOpen).toBe(expected);
    // At least the planted unassigned HIGH + assigned URGENT.
    expect(expected).toBeGreaterThanOrEqual(2);
  });

  it("tasks figures equal an in-test computation from listTasks", async () => {
    const model = await supportHomeSvc.getSupportConsole(supportActor);
    const list = await tasksSvc.listTasks(supportActor, { queue: "mine", pageSize: 100 });
    const open = list.items.filter(
      (t) => !(opsDomain.TASK_TERMINAL_STATUSES as readonly string[]).includes(t.status),
    );
    const tomorrowStart = reportsDomain.kathmanduDayStartUtc(
      reportsDomain.addDays(reportsDomain.kathmanduToday(), 1),
    );
    const now = new Date();
    const expectedDue = open.filter(
      (t) => t.dueAt !== null && new Date(t.dueAt) < tomorrowStart,
    ).length;
    const expectedOverdue = open.filter(
      (t) => t.dueAt !== null && new Date(t.dueAt) < now,
    ).length;
    expect(model.tasksDue).toBe(expectedDue);
    expect(model.tasksOverdue).toBe(expectedOverdue);
    expect(expectedOverdue).toBeGreaterThanOrEqual(1);

    const expectedRows = [...open]
      .sort((a, b) => {
        if (a.dueAt === null && b.dueAt === null) return 0;
        if (a.dueAt === null) return 1;
        if (b.dueAt === null) return -1;
        return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
      })
      .slice(0, 8)
      .map((t) => t.id);
    expect(model.myTasks.map((t) => t.id)).toEqual(expectedRows);
    // The planted overdue task leads; the CLOSED task never appears.
    expect(model.myTasks.map((t) => t.id)).toContain(fx["task-overdue"]);
    expect(model.myTasks.map((t) => t.id)).not.toContain(fx["task-closed"]);
    const overdueRow = model.myTasks.find((t) => t.id === fx["task-overdue"]);
    expect(overdueRow?.overdue).toBe(true);
  });

  it("can flags are set from the actor's real grants", async () => {
    const model = await supportHomeSvc.getSupportConsole(supportActor);
    expect(model.can).toEqual({ viewTickets: true, incidents: true, tasks: true });
  });

  it("serialised model contains no finance key at any depth", async () => {
    const model = await supportHomeSvc.getSupportConsole(supportActor);
    const keys = allKeys(JSON.parse(JSON.stringify(model)));
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      expect(key).not.toMatch(/paisa|amount|price|cod|invoice|payment|revenue/i);
    }
  });

  it("a vendor actor without support.ticket.manage is refused", async () => {
    await expect(supportHomeSvc.getSupportConsole(vendorActor)).rejects.toThrow();
  });
});
