import type { ReactNode } from "react";

import { TONE_HEX, type StatusTone } from "@/lib/status/status-tones";

/**
 * ActivityTimeline (V3 Step 9, DS §7.10 treatment applied to
 * audit/activity surfaces) — a presentational vertical timeline:
 * a tone dot per item (colour is redundant encoding — the label and
 * meta text always render), a connecting line between items, the
 * label in ink, and actor / time / detail as ink-2 meta lines.
 *
 * Server-safe: no "use client", no hooks, no state. An item with an
 * `onSelect` renders as a full-row button; without one it renders as
 * a static row. The component owns no data and no behaviour beyond
 * forwarding the click — callers compose every field from the view
 * they already render.
 */

export type ActivityTimelineTone = StatusTone;

export interface ActivityTimelineItem {
  id: string;
  label: ReactNode;
  actor?: ReactNode;
  time: ReactNode;
  detail?: ReactNode;
  tone?: ActivityTimelineTone;
  onSelect?: () => void;
}

function TimelineItemBody({ item }: { item: ActivityTimelineItem }) {
  return (
    <>
      <span className="block text-[13.5px] font-medium text-ink">{item.label}</span>
      {item.actor ? (
        <span className="mt-0.5 block text-[12.5px] text-ink-2">{item.actor}</span>
      ) : null}
      <span className="mt-0.5 block text-[12.5px] text-ink-2">{item.time}</span>
      {item.detail ? (
        <span className="mt-0.5 block text-[12.5px] text-ink-2">{item.detail}</span>
      ) : null}
    </>
  );
}

export function ActivityTimeline({
  items,
  ariaLabel = "Activity timeline",
  className,
}: {
  items: ActivityTimelineItem[];
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <ol aria-label={ariaLabel} className={className}>
      {items.map((item, index) => {
        const tone = item.tone ?? "neutral";
        const isLast = index === items.length - 1;
        return (
          <li key={item.id} className="relative flex gap-3">
            {/* Connector line: runs from this dot to the next one. */}
            {!isLast ? (
              <span
                aria-hidden="true"
                className="absolute bottom-0 left-[5px] top-[18px] w-px bg-border"
              />
            ) : null}
            <span
              aria-hidden="true"
              data-tone={tone}
              className="mt-[5px] h-[11px] w-[11px] shrink-0 rounded-full"
              style={{ backgroundColor: TONE_HEX[tone].text }}
            />
            <div className={`min-w-0 flex-1 ${isLast ? "" : "pb-5"}`}>
              {item.onSelect ? (
                <button
                  type="button"
                  onClick={item.onSelect}
                  className="block w-full rounded-md text-left hover:bg-surface-2 focus-visible:bg-surface-2"
                >
                  <TimelineItemBody item={item} />
                </button>
              ) : (
                <div>
                  <TimelineItemBody item={item} />
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
