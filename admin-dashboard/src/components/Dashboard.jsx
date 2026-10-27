import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import StatsBar from './StatsBar';
import LiveMap from './LiveMap';
import { RevenueChart } from './RevenueChart';
import { Donut, StatusPill, fmtINR, fmtTime } from './widgets';

function Panel({ title, sub, action, children, className = '' }) {
  return (
    <section className={`rounded-lg border border-line bg-surface p-5 ${className}`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-bold text-ink">{title}</h2>
          {sub ? <p className="mt-0.5 text-xs text-faint">{sub}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function LinkArrow({ children, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 text-xs font-medium text-slate2 transition hover:text-brand"
    >
      {children}
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M2 6h8 M7.5 3.5L10 6l-2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

export default function Dashboard({ days, onOpenPage, onCreateOrder, onAssignDriver, onOpenCustomers, onAddItem, online }) {
  const [trends, setTrends] = useState(null);
  const [revenue, setRevenue] = useState(null);
  const [activity, setActivity] = useState(null);
  const [payments, setPayments] = useState(null);
  const [recent, setRecent] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setError('');
    Promise.all([
      api.getTrends(days),
      api.getRevenue(days),
      api.getActivity(6),
      api.getPaymentsSummary(),
      api.listOrders(),
    ])
      .then(([t, r, a, p, orders]) => {
        if (!active) return;
        setTrends(t);
        setRevenue(r);
        setActivity(a);
        setPayments(p);
        setRecent((orders ?? []).slice(0, 4));
      })
      .catch((e) => {
        if (active) setError(`Dashboard failed to load: ${e.message}`);
      });
    return () => {
      active = false;
    };
  }, [days]);

  const acts = activity?.activity ?? [];
  const payRows = [
    { label: 'Paid', color: 'bg-green', value: payments?.paid ?? 0 },
    { label: 'Pending', color: 'bg-amber', value: payments?.pending ?? 0 },
    { label: 'Failed', color: 'bg-red', value: payments?.failed ?? 0 },
  ];


  return (
    <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 space-y-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
            BLA Delivery Ops
          </p>
          <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-[26px] font-bold leading-tight text-ink">Operations Dashboard</h1>
              <p className="mt-1 text-[13px] text-slate2">
                Orders, drivers, cashflow and customers — live from Supabase.
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs text-faint">
              <span>
                <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${online ? 'bg-green' : 'bg-amber'}`} />
                {online ? 'Live · Real-time updates' : 'Offline · retrying'}
              </span>
            </div>
          </div>
        </div>

        {error ? (
          <p className="rounded-lg border border-line bg-surface p-4 text-sm text-red">{error}</p>
        ) : null}

        <StatsBar trends={trends} />

        <div className="grid gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
          <Panel
            title="Revenue & Orders"
            sub={`Last ${revenue?.days ?? days} days`}
            action={
              <div className="flex items-center gap-3 text-[11px] text-slate2">
                <span className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-brand" /> Revenue
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#A78BFA]" /> Orders
                </span>
              </div>
            }
          >
            <RevenueChart labels={revenue?.labels} revenue={revenue?.revenue} orders={revenue?.orders} />
          </Panel>

          <Panel title="Live Deliveries" action={<span className="text-brand">View all</span>}>
            <button
              type="button"
              onClick={() => onOpenPage('orders')}
              className="relative block w-full overflow-hidden rounded-md border border-line text-left"
              style={{ height: 190 }}
              aria-label="Open the full live map"
            >
              <LiveMap compact interactive={false} />
            </button>
          </Panel>
        </div>

        <Panel
          title="Recent Activity"
          action={<LinkArrow onClick={() => onOpenPage('orders')}>View all</LinkArrow>}
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-[11px] font-medium text-faint">
                  <th className="pb-2 pr-3 font-medium">Time</th>
                  <th className="pb-2 pr-3 font-medium">Order ID</th>
                  <th className="pb-2 pr-3 font-medium">Status</th>
                  <th className="pb-2 pr-3 font-medium">Payment</th>
                  <th className="pb-2 pr-3 font-medium">Customer</th>
                  <th className="pb-2 pr-3 font-medium">Details</th>
                  <th className="pb-2 font-medium" aria-label="Open" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F1F5F9]">
                {acts.map((a) => (
                  <tr key={a.order_id} className="text-slate2">
                    <td className="whitespace-nowrap py-3 pr-3">{fmtTime(a.time)}</td>
                    <td className="whitespace-nowrap py-3 pr-3 font-medium text-ink">{a.order_number}</td>
                    <td className="py-3 pr-3"><StatusPill status={a.status} /></td>
                    <td className="whitespace-nowrap py-3 pr-3 uppercase">{a.payment_method}</td>
                    <td className="py-3 pr-3">{a.customer}</td>
                    <td className="py-3 pr-3">{a.details}</td>
                    <td className="py-3 text-right text-faint">›</td>
                  </tr>
                ))}
                {acts.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-faint">No activity yet.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <div className="space-y-4">
        <Panel
          title="Recent Orders"
          action={<LinkArrow onClick={() => onOpenPage('orders')}>View all</LinkArrow>}
        >
          <div className="divide-y divide-[#F1F5F9]">
            {recent.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => onOpenPage('orders')}
                className="flex w-full items-center gap-2 py-3 text-left"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[13px] font-semibold text-ink">{o.order_number}</span>
                    <StatusPill status={o.status} />
                  </div>
                  <div className="tnum mt-0.5 text-[13px] font-semibold text-ink">{fmtINR(o.total_amount)}</div>
                  <div className="mt-0.5 text-[11px] text-faint">{fmtTime(o.created_at)}</div>
                </div>
                <span className="text-faint">›</span>
              </button>
            ))}
            {recent.length === 0 ? (
              <p className="py-4 text-center text-[13px] text-faint">No orders yet.</p>
            ) : null}
          </div>
        </Panel>

        <Panel title="Quick Actions">
          <div className="grid grid-cols-2 gap-2.5">
            {[
              { label: 'Create Order', icon: 'M10 4v12 M4 10h12', onClick: onCreateOrder },
              { label: 'Add Customer', icon: 'M10 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M3 17c0-3 3-5 7-5s7 2 7 5', onClick: onOpenCustomers },
              { label: 'Assign Driver', icon: 'M2 6.5h11V13H2z M13 9.5h2.6L17 11.5V13h-4z M5.5 16h.01 M15.5 16h.01', onClick: onAssignDriver },
              { label: 'Add Item', icon: 'M10 3l6 3v8l-6 3-6-3V6z M4 6l6 3 6-3 M10 9v8', onClick: onAddItem },
            ].map((qa) => (
              <button
                key={qa.label}
                type="button"
                onClick={qa.onClick}
                className="flex h-[64px] items-center justify-center gap-2 rounded-md border border-line bg-surface text-[13px] font-medium text-ink transition hover:border-slate2"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-cream text-slate2">
                  <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d={qa.icon} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                {qa.label}
              </button>
            ))}
          </div>
        </Panel>

        <Panel
          title="Payment Status"
          action={<LinkArrow onClick={() => onOpenPage('payments')}>View details</LinkArrow>}
        >
          <div className="flex items-center gap-5">
            <Donut
              paid={payments?.paid ?? 0}
              pending={payments?.pending ?? 0}
              failed={payments?.failed ?? 0}
              total={fmtINR(payments?.total_paid ?? 0, 2)}
            />
            <div className="flex-1 space-y-3 text-[13px]">
              {payRows.map((r) => (
                <div key={r.label} className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${r.color}`} />
                  <span className="flex-1 text-slate2">{r.label}</span>
                  <span className="tnum font-semibold text-ink">{r.value}</span>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

