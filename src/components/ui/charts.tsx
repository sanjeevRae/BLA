/**
 * Hand-rolled SVG chart primitives (DS §7.12) — NO chart library.
 *
 * Three shapes only: BarChart (zero-baseline vertical bars), LineChart
 * (time trend), DistributionBar (one stacked horizontal bar with a
 * legend — never a pie/donut). The primary series is `primary`; status
 * colours appear only in DistributionBar, whose segments ARE statuses.
 *
 * Accessibility (DS §7.12): every chart's SVG carries role="img" +
 * aria-label, every datum is keyboard-reachable (focusable <g> with a
 * <title> tooltip, WCAG 1.4.13), and the full series is repeated in a
 * visually-hidden data table next to the SVG. No invented smoothing,
 * no gradients, no animation beyond CSS hover.
 *
 * Honesty rule (DS §7.12 / audit G3): an empty series — or one whose
 * values are all zero — renders the honest empty state ("No activity
 * in this period"), never a wall of empty bars.
 */

export type ChartPoint = { label: string; value: number };

const CHART_WIDTH = 640;
const PAD = { top: 28, right: 12, bottom: 30, left: 8 };
/** Direct labels fit at most this many series points (DS §7.12). */
const DIRECT_LABEL_LIMIT = 14;

/** ~58px per x label at the fixed viewBox width, so labels never collide. */
function labelEvery(count: number): number {
  const maxLabels = Math.max(1, Math.floor(CHART_WIDTH / 58));
  return Math.max(1, Math.ceil(count / maxLabels));
}

function isEmptySeries(data: ChartPoint[]): boolean {
  return data.length === 0 || data.every((point) => point.value === 0);
}

function ChartEmptyState() {
  return (
    <div className="flex items-center justify-center rounded-lg border border-border bg-card px-4 py-10">
      <p className="text-[13px] text-ink-2">No activity in this period</p>
    </div>
  );
}

/** The series as a real table, visually hidden — the screen-reader
 * alternative to the SVG (DS §7.12: data present as adjacent text/table). */
function SrDataTable({
  ariaLabel,
  valueLabel,
  rows,
}: {
  ariaLabel: string;
  valueLabel?: string;
  rows: { label: string; value: string }[];
}) {
  return (
    <table className="sr-only">
      <caption>{ariaLabel}</caption>
      <thead>
        <tr>
          <th scope="col">Label</th>
          <th scope="col">{valueLabel ?? "Value"}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th scope="row">{row.label}</th>
            <td>{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function datumLabel(point: ChartPoint, valueLabel?: string): string {
  return `${point.label} — ${point.value}${valueLabel ? ` ${valueLabel}` : ""}`;
}

export function BarChart({
  data,
  ariaLabel,
  valueLabel,
  height = 240,
}: {
  data: ChartPoint[];
  ariaLabel: string;
  valueLabel?: string;
  height?: number;
}) {
  if (isEmptySeries(data)) return <ChartEmptyState />;

  const max = Math.max(...data.map((point) => point.value));
  const plotW = CHART_WIDTH - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const baseY = PAD.top + plotH;
  const slot = plotW / data.length;
  const barW = Math.min(44, slot * 0.6);
  const directLabels = data.length <= DIRECT_LABEL_LIMIT;
  const every = labelEvery(data.length);

  return (
    <figure className="w-full">
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox={`0 0 ${CHART_WIDTH} ${height}`}
        width="100%"
        height={height}
        className="block"
      >
        {!directLabels ? (
          <text
            x={PAD.left}
            y={16}
            className="fill-ink-2 text-[11px] tabular-nums"
          >
            {valueLabel ? `${valueLabel}: max ${max}` : `Max ${max}`}
          </text>
        ) : null}
        <line
          x1={PAD.left}
          x2={CHART_WIDTH - PAD.right}
          y1={baseY}
          y2={baseY}
          className="stroke-border"
          strokeWidth={1}
        />
        {data.map((point, index) => {
          const barH = (point.value / max) * plotH;
          const x = PAD.left + slot * index + (slot - barW) / 2;
          const y = baseY - barH;
          const center = PAD.left + slot * index + slot / 2;
          const label = datumLabel(point, valueLabel);
          return (
            <g key={`${point.label}-${index}`}>
              <g tabIndex={0} role="img" aria-label={label} className="outline-none">
                <title>{label}</title>
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={barH}
                  rx={3}
                  className="fill-primary"
                />
              </g>
              {directLabels ? (
                <text
                  x={center}
                  y={y - 6}
                  textAnchor="middle"
                  className="fill-ink text-[11px] font-[550] tabular-nums"
                >
                  {point.value}
                </text>
              ) : null}
              {index % every === 0 ? (
                <text
                  x={center}
                  y={baseY + 18}
                  textAnchor="middle"
                  className="fill-ink-2 text-[11px]"
                >
                  {point.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <SrDataTable
        ariaLabel={ariaLabel}
        valueLabel={valueLabel}
        rows={data.map((point) => ({
          label: point.label,
          value: String(point.value),
        }))}
      />
    </figure>
  );
}

export function LineChart({
  data,
  ariaLabel,
  valueLabel,
  height = 240,
}: {
  data: ChartPoint[];
  ariaLabel: string;
  valueLabel?: string;
  height?: number;
}) {
  if (isEmptySeries(data)) return <ChartEmptyState />;

  const max = Math.max(...data.map((point) => point.value));
  const plotW = CHART_WIDTH - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const baseY = PAD.top + plotH;
  const xAt = (index: number) =>
    data.length === 1
      ? PAD.left + plotW / 2
      : PAD.left + (plotW * index) / (data.length - 1);
  const yAt = (value: number) => baseY - (value / max) * plotH;
  const points = data
    .map((point, index) => `${xAt(index)},${yAt(point.value)}`)
    .join(" ");
  const areaPoints =
    data.length > 1
      ? `${points} ${xAt(data.length - 1)},${baseY} ${xAt(0)},${baseY}`
      : null;
  const every = labelEvery(data.length);

  return (
    <figure className="w-full">
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox={`0 0 ${CHART_WIDTH} ${height}`}
        width="100%"
        height={height}
        className="block"
      >
        <text x={PAD.left} y={16} className="fill-ink-2 text-[11px] tabular-nums">
          {valueLabel ? `${valueLabel}: max ${max}` : `Max ${max}`}
        </text>
        {areaPoints ? (
          <polygon points={areaPoints} className="fill-primary-light" />
        ) : null}
        {data.length > 1 ? (
          <polyline
            points={points}
            fill="none"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            className="stroke-primary"
          />
        ) : null}
        <line
          x1={PAD.left}
          x2={CHART_WIDTH - PAD.right}
          y1={baseY}
          y2={baseY}
          className="stroke-border"
          strokeWidth={1}
        />
        {data.map((point, index) => {
          const label = datumLabel(point, valueLabel);
          return (
            <g key={`${point.label}-${index}`}>
              <g tabIndex={0} role="img" aria-label={label} className="outline-none">
                <title>{label}</title>
                <circle
                  cx={xAt(index)}
                  cy={yAt(point.value)}
                  r={4}
                  strokeWidth={2}
                  className="fill-card stroke-primary"
                />
              </g>
              {index % every === 0 ? (
                <text
                  x={xAt(index)}
                  y={baseY + 18}
                  textAnchor="middle"
                  className="fill-ink-2 text-[11px]"
                >
                  {point.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <SrDataTable
        ariaLabel={ariaLabel}
        valueLabel={valueLabel}
        rows={data.map((point) => ({
          label: point.label,
          value: String(point.value),
        }))}
      />
    </figure>
  );
}

export type DistributionTone =
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "neutral"
  | "brand";

/** Solid tone fills for bar segments + legend dots (the tint classes in
 * TONE_CLASSES are for badge surfaces; a stacked bar needs the solid
 * tone itself). Brand = primary. */
const DISTRIBUTION_BG_CLASSES: Record<DistributionTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
  neutral: "bg-neutral",
  brand: "bg-primary",
};

export type DistributionSegment = {
  label: string;
  value: number;
  tone: DistributionTone;
};

export function DistributionBar({
  segments,
  ariaLabel,
}: {
  segments: DistributionSegment[];
  ariaLabel: string;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (segments.length === 0 || total === 0) return <ChartEmptyState />;

  const percent = (value: number) => Math.round((value / total) * 100);

  return (
    <figure className="w-full">
      <div
        role="img"
        aria-label={ariaLabel}
        data-testid="distribution-bar"
        className="flex h-3.5 w-full overflow-hidden rounded-md bg-neutralbg"
      >
        {segments
          .filter((segment) => segment.value > 0)
          .map((segment) => (
            <div
              key={segment.label}
              title={`${segment.label} — ${segment.value} (${percent(segment.value)}%)`}
              className={DISTRIBUTION_BG_CLASSES[segment.tone]}
              style={{ width: `${(segment.value / total) * 100}%` }}
            />
          ))}
      </div>
      <ul data-testid="distribution-legend" className="mt-3 grid gap-1.5">
        {segments.map((segment) => (
          <li
            key={segment.label}
            className="flex items-center gap-2 text-[13px]"
          >
            <span
              aria-hidden="true"
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${DISTRIBUTION_BG_CLASSES[segment.tone]}`}
            />
            <span className="min-w-0 flex-1 truncate text-ink">{segment.label}</span>
            <span className="tabular-nums text-ink">{segment.value}</span>
            <span className="w-10 text-right tabular-nums text-ink-2">
              {percent(segment.value)}%
            </span>
          </li>
        ))}
      </ul>
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">Label</th>
            <th scope="col">Count</th>
            <th scope="col">Percentage</th>
          </tr>
        </thead>
        <tbody>
          {segments.map((segment) => (
            <tr key={segment.label}>
              <th scope="row">{segment.label}</th>
              <td>{segment.value}</td>
              <td>{percent(segment.value)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
