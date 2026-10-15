import React from 'react';

export function fmtINR(value, decimals = 0) {
  // Plain "Rs." prefix — Intl's ₹ symbol was replaced per product request.
  return `Rs. ${new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: decimals,
  }).format(Number(value || 0))}`;
}

export function fmtTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return '—';
  }
}

const PILL = {
  received: 'bg-greenbg text-green',
  delivered: 'bg-greenbg text-green',
  on_place: 'bg-accentbg text-brand',
  went_for_delivery: 'bg-accentbg text-brand',
  out_for_delivery: 'bg-accentbg text-brand',
  cancelled: 'bg-[#FDECEC] text-red',
  failed: 'bg-[#FDECEC] text-red',
};

export function StatusPill({ status }) {
  const s = String(status ?? 'received');
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${PILL[s] ?? 'bg-cream text-slate2'}`}>
      {(s === 'received' || s === 'delivered') && (
        <span className="h-1.5 w-1.5 rounded-full bg-green" />
      )}
      {s.replace(/_/g, ' ')}
    </span>
  );
}

function points(data, w, h, pad = 3) {
  const vals = (data ?? []).map(Number);
  if (!vals.length) return '';
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const step = vals.length > 1 ? (w - pad * 2) / (vals.length - 1) : 0;
  return vals
    .map((v, i) => `${(pad + i * step).toFixed(1)},${(h - pad - ((v - min) / span) * (h - pad * 2)).toFixed(1)}`)
    .join(' ');
}

export function Sparkline({ data, color = '#2563EB', width = 120, height = 44, fill = true, id }) {
  const pts = points(data, width, height);
  if (!pts) return <div style={{ width, height }} />;
  const gid = `sg-${id ?? Math.abs(String(data).length * 31 + width)}`;
  const last = pts.trim().split(' ').pop().split(',');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && (
        <polygon points={`${3},${height - 1} ${pts} ${width - 3},${height - 1}`} fill={`url(#${gid})`} />
      )}
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="2.6" fill={color} />
    </svg>
  );
}

export function Donut({ paid = 0, pending = 0, failed = 0, total = 'Rs. 0.00' }) {
  const sum = paid + pending + failed;
  const R = 54;
  const C = 2 * Math.PI * R;
  const segs = [
    { v: paid, color: '#16A34A' },
    { v: pending, color: '#F59E0B' },
    { v: failed, color: '#DC2626' },
  ];
  let acc = 0;
  return (
    <div className="relative h-[150px] w-[150px]">
      <svg viewBox="0 0 130 130" className="h-full w-full -rotate-90">
        <circle cx="65" cy="65" r={R} fill="none" stroke="#E6EBF0" strokeWidth="13" />
        {sum > 0 &&
          segs.map((s, i) => {
            const frac = s.v / sum;
            const el = (
              <circle
                key={i}
                cx="65"
                cy="65"
                r={R}
                fill="none"
                stroke={s.color}
                strokeWidth="13"
                strokeDasharray={`${(frac * C).toFixed(1)} ${C.toFixed(1)}`}
                strokeDashoffset={(-acc * C).toFixed(1)}
                strokeLinecap="round"
              />
            );
            acc += frac;
            return el;
          })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-[15px] font-bold text-ink">{total}</div>
        <div className="text-[11px] text-faint">Total</div>
      </div>
    </div>
  );
}
