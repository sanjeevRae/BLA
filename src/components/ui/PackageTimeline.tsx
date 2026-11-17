import { formatDateTime } from "@/components/bookings/ui";
import { ToneIcon } from "./ToneIcon";

/**
 * PackageTimeline (docs/ui-design-system.md §7.10) — vertical
 * progress timeline for the public tracking page and package detail
 * surfaces.
 *
 * Anatomy per step state:
 * - `completed` — Success-tone filled circle with a check icon, ink
 *   label, timestamp.
 * - `current` — primary filled circle with a subtle pulse ring
 *   (motion-safe only, so `prefers-reduced-motion` disables it),
 *   semibold label, timestamp; the only step carrying
 *   `aria-current="step"`.
 * - `upcoming` — neutral outline circle, ink-2 label, NO timestamp
 *   (a future step has no honest time to show).
 * - `cancelled` — Failed-tone filled circle with the Failed icon,
 *   ink label, timestamp, no pulse and no `aria-current`: a
 *   cancelled parcel's last recorded event is terminal history, not
 *   a step in progress.
 *
 * Connector segments are Success below a completed step and the
 * `border` colour after the current step (and everywhere else).
 *
 * `occurredAt` is an ISO timestamp string; it is formatted for
 * display here and also emitted as the `<time dateTime>` value.
 * Steps are rendered in the order given — the component never
 * invents, reorders or projects steps.
 */
export type PackageTimelineStepState = "completed" | "current" | "upcoming" | "cancelled";

export interface PackageTimelineStep {
  label: string;
  occurredAt?: string | null;
  state: PackageTimelineStepState;
}

function StepMarker({ state }: { state: PackageTimelineStepState }) {
  if (state === "completed") {
    return (
      <span className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success text-white">
        <ToneIcon tone="success" className="h-[14px] w-[14px]" />
      </span>
    );
  }
  if (state === "current") {
    return (
      <span className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center">
        <span
          aria-hidden="true"
          data-pulse-ring="true"
          className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-25 motion-safe:animate-ping"
        />
        <span className="relative inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-white" />
        </span>
      </span>
    );
  }
  if (state === "cancelled") {
    return (
      <span className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-danger text-white">
        <ToneIcon tone="danger" className="h-[14px] w-[14px]" />
      </span>
    );
  }
  return (
    <span className="relative z-10 h-6 w-6 shrink-0 rounded-full border-2 border-border-control bg-card" />
  );
}

const LABEL_CLASSES: Record<PackageTimelineStepState, string> = {
  completed: "font-medium text-ink",
  current: "font-semibold text-ink",
  upcoming: "text-ink-2",
  cancelled: "font-semibold text-ink",
};

export function PackageTimeline({
  steps,
  caption,
  ariaLabel = "Package progress",
}: {
  steps: readonly PackageTimelineStep[];
  caption?: string;
  ariaLabel?: string;
}) {
  if (steps.length === 0) return null;
  return (
    <>
      {caption ? <p className="mb-4 text-meta text-ink-2">{caption}</p> : null}
      <ol aria-label={ariaLabel}>
        {steps.map((step, index) => {
          const isLast = index === steps.length - 1;
          // Upcoming steps never show a timestamp (DS §7.10); every
          // other state shows one only when the step carries it.
          const showTime = step.state !== "upcoming" && Boolean(step.occurredAt);
          return (
            <li
              key={index}
              data-state={step.state}
              aria-current={step.state === "current" ? "step" : undefined}
              className="relative flex gap-3 pb-5 last:pb-0"
            >
              {!isLast ? (
                <span
                  aria-hidden="true"
                  className={`absolute bottom-0 left-[11px] top-7 w-[2px] ${
                    step.state === "completed" ? "bg-success" : "bg-border"
                  }`}
                />
              ) : null}
              <StepMarker state={step.state} />
              <span className="min-w-0 pt-0.5">
                <span className={`block text-body leading-snug ${LABEL_CLASSES[step.state]}`}>
                  {step.label}
                </span>
                {showTime ? (
                  <time
                    dateTime={step.occurredAt as string}
                    className="mt-0.5 block whitespace-nowrap text-meta tabular-nums text-ink-2"
                  >
                    {formatDateTime(step.occurredAt as string)}
                  </time>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

/**
 * Map the FROZEN public-tracking projection (see
 * `getPublicTracking` in src/server/services/packages.ts — exactly
 * the recorded event history, nothing projected) onto timeline
 * steps:
 *
 * - every recorded event except the last is `completed`;
 * - the last event is `current` while the parcel is in flight;
 * - DELIVERED is terminal: the last event is `completed` too — the
 *   journey is done, so nothing is "current";
 * - CANCELLED is terminal: the last event renders as `cancelled`
 *   (Failed-tone marker, no pulse, no `aria-current`) — neither
 *   "current" nor a neutral "upcoming" would be honest;
 * - an empty timeline maps to no steps (the page renders its
 *   "No events recorded yet" empty state instead).
 *
 * No future steps are ever synthesised: the lifecycle has legitimate
 * branches (local deliveries skip the transfer leg; returns re-enter
 * dispatch), so projecting upcoming milestones from the current
 * status could state things that never happen.
 */
export function publicTrackingToSteps(view: {
  status: string;
  timeline: readonly { label: string; occurredAt: string }[];
}): PackageTimelineStep[] {
  return view.timeline.map((event, index) => {
    const isLast = index === view.timeline.length - 1;
    if (!isLast) {
      return { label: event.label, occurredAt: event.occurredAt, state: "completed" };
    }
    if (view.status === "DELIVERED") {
      return { label: event.label, occurredAt: event.occurredAt, state: "completed" };
    }
    if (view.status === "CANCELLED") {
      return { label: event.label, occurredAt: event.occurredAt, state: "cancelled" };
    }
    return { label: event.label, occurredAt: event.occurredAt, state: "current" };
  });
}
