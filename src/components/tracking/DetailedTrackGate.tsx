"use client";

import { useState, type FormEvent } from "react";

import { formatDateTime } from "@/components/bookings/ui";

/**
 * Detailed tracking gate (security-architecture §7): the basic
 * public projection above needs only the tracking code; the
 * detailed timeline additionally requires the recipient phone
 * number on the package record. Every failure — wrong phone,
 * unknown code, locked — renders the same generic message, exactly
 * as the API returns the same 404 envelope.
 */

interface DetailedView {
  recipientName: string;
  timeline: {
    status: string;
    label: string;
    occurredAt: string;
    warehouseCity: string | null;
  }[];
  proofOfDelivery: {
    deliveredAt: string;
    receivedByName: string | null;
    method: string;
  } | null;
}

export function DetailedTrackGate({ trackingId }: { trackingId: string }) {
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<DetailedView | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/track/${encodeURIComponent(trackingId)}/details`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: phone.trim() }),
        },
      );
      if (!res.ok) {
        setView(null);
        setError(
          "Tracking details are not available for this tracking code and phone number.",
        );
        return;
      }
      setView((await res.json()) as DetailedView);
    } catch {
      setError("Something went wrong — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-lg border border-line bg-surface p-5">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
        Detailed tracking
      </h2>
      <p className="mt-2 text-[13px] text-slate2">
        Enter the recipient phone number used for this delivery to see the full timeline
        and delivery proof.
      </p>
      <form onSubmit={onSubmit} className="mt-3 flex flex-wrap gap-2">
        <input
          className="min-w-[220px] flex-1 rounded-md border border-line bg-page px-3 py-2 text-[13px] text-ink"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Recipient phone, e.g. 98XXXXXXXX"
          inputMode="tel"
          required
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-brand px-4 py-2 text-[13px] font-semibold text-white"
        >
          {busy ? "Checking…" : "View details"}
        </button>
      </form>
      {error ? <p className="mt-3 text-[13px] text-red">{error}</p> : null}
      {view ? (
        <div className="mt-4">
          <p className="text-[13px] text-slate2">
            Recipient: <span className="font-semibold text-ink">{view.recipientName}</span>
          </p>
          {view.proofOfDelivery ? (
            <p className="mt-1 text-[13px] text-slate2">
              Delivered {formatDateTime(view.proofOfDelivery.deliveredAt)} · Received by{" "}
              <span className="font-semibold text-ink">
                {view.proofOfDelivery.receivedByName ?? "the recipient"}
              </span>{" "}
              · Verified by {view.proofOfDelivery.method}
            </p>
          ) : null}
          <ol className="mt-4 grid gap-0">
            {view.timeline.map((event, index) => (
              <li key={index} className="relative flex gap-3 pb-4 last:pb-0">
                <span
                  className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${
                    index === view.timeline.length - 1 ? "bg-brand" : "bg-line"
                  }`}
                />
                <span className="text-[13px]">
                  <span className="font-semibold text-ink">{event.label}</span>
                  {event.warehouseCity ? (
                    <span className="text-slate2"> · {event.warehouseCity}</span>
                  ) : null}{" "}
                  <span className="text-faint">· {formatDateTime(event.occurredAt)}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
