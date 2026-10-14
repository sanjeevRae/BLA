import React from 'react';

function niceMax(v) {
  if (v <= 0) return 10;
  const exp = Math.floor(Math.log10(v));
  const base = v / 10 ** exp;
  const nice = base <= 1 ? 1 : base <= 2 ? 2 : base <= 5 ? 5 : 10;
  return nice * 10 ** exp;
}

function smoothPath(xs, ys) {
  if (xs.length < 2) return xs.length ? `M ${xs[0]},${ys[0]}` : '';
  let d = `M ${xs[0]},${ys[0]}`;
  for (let i = 0; i < xs.length - 1; i++) {
    const mx = (xs[i] + xs[i + 1]) / 2;
    d += ` C ${mx},${ys[i]} ${mx},${ys[i + 1]} ${xs[i + 1]},${ys[i + 1]}`;
  }
  return d;
}

export function RevenueChart({ labels = [], revenue = [], orders = [] }) {
  const W = 560;
  const H = 220;
  const padL = 46;
  const padR = 10;
  const padT = 12;
  const padB = 26;
  const n = Math.max(labels.length, revenue.length, orders.length, 1);
  const revMax = niceMax(Math.max(...revenue.map(Number), 0));
  const ordMax = niceMax(Math.max(...orders.map(Number), 0));
  const xs = (i) => padL + (n > 1 ? (i * (W - padL - padR)) / (n - 1) : 0);
  const yR = (v) => padT + (1 - Number(v || 0) / revMax) * (H - padT - padB);
  const yO = (v) => padT + (1 - Number(v || 0) / ordMax) * (H - padT - padB);
  const idx = Array.from({ length: n }, (_, i) => i);
  const revPath = smoothPath(idx.map(xs), revenue.map((_, i) => yR(revenue[i])));
  const ordPath = smoothPath(idx.map(xs), orders.map((_, i) => yO(orders[i])));
  const base = H - padB;
  const step = Math.max(1, Math.ceil(n / 7));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Revenue and orders chart">
      <defs>
        <linearGradient id="revfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2563EB" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#2563EB" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 1, 2, 3].map((t) => {
        const y = padT + (t / 3) * (H - padT - padB);
        const val = Math.round(revMax * (1 - t / 3));
        return (
          <g key={t}>
            <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="#EDF1F5" strokeWidth="1" />
            <text x={padL - 6} y={y + 4} textAnchor="end" fontSize="10" fill="#94A3B8">
              ₹{val >= 1000 ? `${Math.round(val / 1000)},000` : val}
            </text>
          </g>
        );
      })}
      {idx
        .filter((i) => i % step === 0 || i === n - 1)
        .map((i) => (
          <text key={i} x={xs(i)} y={H - 6} textAnchor="middle" fontSize="10" fill="#94A3B8">
            {labels[i] ?? ''}
          </text>
        ))}
      <path d={`${revPath} L ${xs(n - 1)},${base} L ${xs(0)},${base} Z`} fill="url(#revfill)" />
      <path d={ordPath} fill="none" stroke="#A78BFA" strokeWidth="1.8" strokeLinecap="round" />
      <path d={revPath} fill="none" stroke="#2563EB" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx={xs(n - 1)} cy={yR(revenue[n - 1] ?? 0)} r="3.4" fill="#2563EB" />
    </svg>
  );
}
