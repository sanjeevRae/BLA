// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, refresh: vi.fn() }),
}));

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ActivityTimeline } from "@/components/ui/ActivityTimeline";
import { AuditListClient } from "@/components/admin-identity/AuditListClient";
import type { AuditLogView, ListAuditLogsResult } from "@/server/services/audit-log";

/**
 * V3 Step 9 (Builder E) — audit ActivityTimeline (DS §7.10 treatment):
 * the presentational timeline renders label/actor/time/detail with a
 * tone dot and forwards clicks; AuditListClient's Table/Timeline
 * toggle renders the SAME result items through the timeline with a
 * friendly action label ("user.suspended" → "User suspended") while
 * the raw dot-code stays out of the timeline label — and still opens
 * the same detail Drawer, where the raw code remains visible.
 */

afterEach(() => {
  cleanup();
  nav.push.mockClear();
});

describe("ActivityTimeline", () => {
  it("renders label, actor, time and detail, with a tone dot per item", () => {
    const { container } = render(
      <ActivityTimeline
        items={[
          {
            id: "1",
            label: "User suspended",
            actor: "Asha Admin (ADMIN)",
            time: "17 Nov 2026, 10:00",
            detail: "User · recorded",
            tone: "success",
          },
          {
            id: "2",
            label: "Access denied",
            actor: "System",
            time: "17 Nov 2026, 10:05",
            detail: "Booking · denied",
            tone: "danger",
          },
        ]}
      />,
    );
    expect(screen.getByText("User suspended")).not.toBeNull();
    expect(screen.getByText("Asha Admin (ADMIN)")).not.toBeNull();
    expect(screen.getByText("17 Nov 2026, 10:00")).not.toBeNull();
    expect(screen.getByText("User · recorded")).not.toBeNull();
    expect(screen.getByText("Access denied")).not.toBeNull();
    // Tone dots: one per item, carrying the tone (colour is redundant
    // encoding — the label text above is the primary channel).
    expect(container.querySelector("[data-tone='success']")).not.toBeNull();
    expect(container.querySelector("[data-tone='danger']")).not.toBeNull();
    // Static items (no onSelect) are not buttons.
    expect(screen.queryByRole("button", { name: /User suspended/ })).toBeNull();
  });

  it("renders an item with onSelect as a button and fires it on click", () => {
    const onSelect = vi.fn();
    render(
      <ActivityTimeline
        items={[
          {
            id: "1",
            label: "User suspended",
            time: "17 Nov 2026, 10:00",
            tone: "success",
            onSelect,
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /User suspended/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

const AUDIT_ITEM: AuditLogView = {
  id: "audit-1",
  actorId: "user-asha",
  actorName: "Asha Admin",
  actorEmail: "asha@example.com",
  actorRole: "ADMIN",
  action: "user.suspended",
  entityType: "User",
  entityId: "user-1234567890",
  warehouseId: null,
  before: null,
  after: null,
  outcome: "recorded",
  createdAt: "2026-11-17T10:00:00.000Z",
};

const RESULT: ListAuditLogsResult = {
  items: [AUDIT_ITEM],
  total: 1,
  page: 1,
  pageSize: 20,
  totalPages: 1,
};

const INITIAL = {
  actorSearch: "",
  action: "",
  entityType: "",
  outcome: "",
  from: "",
  to: "",
};

describe("AuditListClient — Table / Timeline toggle", () => {
  it("defaults to Table, switches to Timeline with the friendly label, and opens the same Drawer", () => {
    render(<AuditListClient basePath="/admin" result={RESULT} initial={INITIAL} />);

    const tableToggle = screen.getByRole("button", { name: "Table" });
    const timelineToggle = screen.getByRole("button", { name: "Timeline" });
    expect(tableToggle.getAttribute("aria-pressed")).toBe("true");
    expect(timelineToggle.getAttribute("aria-pressed")).toBe("false");
    // Table view: the raw dot-code is the action cell, as before.
    expect(screen.getByText("user.suspended")).not.toBeNull();
    expect(screen.queryByText("User suspended")).toBeNull();

    fireEvent.click(timelineToggle);
    expect(timelineToggle.getAttribute("aria-pressed")).toBe("true");
    expect(tableToggle.getAttribute("aria-pressed")).toBe("false");

    // Timeline view: friendly label, actor (+ role) and resource detail.
    expect(screen.getByText("User suspended")).not.toBeNull();
    expect(screen.getByText("Asha Admin (ADMIN)")).not.toBeNull();
    expect(screen.getByText("User · recorded")).not.toBeNull();
    // The raw code does NOT appear as a timeline label (nor anywhere
    // as rendered text while the table is unmounted).
    expect(screen.queryByText("user.suspended")).toBeNull();

    // Clicking the timeline item opens the SAME detail Drawer, where
    // the raw action code remains visible.
    fireEvent.click(screen.getByRole("button", { name: /User suspended/ }));
    expect(screen.getByRole("dialog", { name: "Audit entry" })).not.toBeNull();
    expect(screen.getByText("user.suspended")).not.toBeNull();
  });
});
