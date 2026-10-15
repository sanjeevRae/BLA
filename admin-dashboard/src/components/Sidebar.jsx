import React from 'react';
import { version as APP_VERSION } from '../../package.json';

function Icon({ d, extra }) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
      {extra ? <path d={extra} stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" /> : null}
    </svg>
  );
}

// countKey maps each nav item to a key in the /ops/profile `badges` payload.
export const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: 'M3 3h6v6H3z M11 3h6v6h-6z M3 11h6v6H3z M11 11h6v6h-6z' },
  { id: 'orders', label: 'Orders', countKey: 'orders', icon: 'M4.5 6.5h11v11h-11z M4.5 6.5l1.6-3h9.8l-1.6 3 M7.5 10.5h5 M7.5 13h3' },
  { id: 'inventory', label: 'Items', countKey: 'inventory', icon: 'M10 3l6 3v8l-6 3-6-3V6z M4 6l6 3 6-3 M10 9v8' },
  { id: 'drivers', label: 'Drivers', countKey: 'drivers', icon: 'M10 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M3 17c0-3 3-5 7-5s7 2 7 5' },
  { id: 'clients', label: 'Clients', countKey: 'customers', icon: 'M7 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M2 16c0-2.5 2.5-4 5-4s5 1.5 5 4 M13 6a2 2 0 1 1 2 2 M14 12c2 .5 4 1.8 4 4' },
  { id: 'packages', label: 'Packages', countKey: 'packages', icon: 'M3 6h14v11H3z M3 9h14 M8 6V3h4v3' },
  { id: 'payments', label: 'Payments', countKey: 'payments', icon: 'M3 5h14v10H3z M3 8h14 M6 12h3' },
  { id: 'vehicles', label: 'Vehicles', countKey: 'vehicles', icon: 'M2 6h11v7H2z M13 9h4l1 2v2h-5z M5 16h.01 M16 16h.01' },
  { id: 'warehouses', label: 'Warehouses', countKey: 'warehouses', icon: 'M3 9l7-5 7 5v8H3z M8 17v-5h4v5' },
  { id: 'parcels', label: 'Parcels', countKey: 'shipments', icon: 'M3 6h14v11H3z M3 9h14 M8 6V3h4v3' },
  { id: 'trips', label: 'Trips', countKey: 'trips', icon: 'M2 6h11v7H2z M13 9h4l1 2v2h-5z M5 16h.01 M16 16h.01' },
  { id: 'vendors', label: 'Vendors', countKey: 'vendors', icon: 'M4 7h16l-1 10H5z M8 7V5a2 2 0 0 1 4 0v2' },
  { id: 'tasks', label: 'Tasks', icon: 'M4 5h12v14H4z M7 9h6 M7 13h6 M16 5l4 4 M19 4l2 2-6 6' },
];

export default function Sidebar({ page, onPageChange, profile }) {
  const counts = profile?.badges ?? {};
  return (
    <aside className="sticky top-0 hidden h-screen w-[228px] shrink-0 flex-col border-r border-line bg-surface px-3 py-5 lg:flex">
      <div className="flex items-center gap-2.5 px-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-ink text-sm font-bold text-white">
            B
          </span>
          <div>
            <div className="text-[15px] font-bold leading-none text-ink">BLA</div>
            <div className="mt-1 text-xs text-slate2">Delivery Ops</div>
          </div>
        </div>

      <nav className="mt-6 flex-1 overflow-y-auto" aria-label="Main navigation">
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const active = page === item.id;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onPageChange(item.id)}
                  aria-current={active ? 'page' : undefined}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition ${
                    active
                      ? 'bg-accentbg font-semibold text-brand'
                      : 'text-slate2 hover:bg-cream'
                  }`}
                >
                  <Icon d={item.icon} />
                  <span className="flex-1 text-left">{item.label}</span>
                  {item.countKey && !active && counts[item.countKey] != null ? (
                    <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-accentbg px-1.5 text-[11px] font-semibold text-brand">
                      {counts[item.countKey]}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="my-4 border-t border-line" />

        <ul className="space-y-1">
          <li key="notifications">
            <button type="button" className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-slate2 transition hover:bg-cream">
              <Icon d="M6 16v-5a4 4 0 1 1 8 0v5l1.5 2h-11z M8.5 19.5a1.5 1.5 0 0 0 3 0" />
              <span className="flex-1 text-left">Notifications</span>
              {counts.notifications != null && counts.notifications > 0 ? (
                <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-accentbg px-1.5 text-[11px] font-semibold text-brand">
                  {counts.notifications}
                </span>
              ) : null}
            </button>
          </li>
          <li key="help">
            <button type="button" className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-slate2 transition hover:bg-cream">
              <Icon d="M10 16.5h.01 M7 8.5a3 3 0 1 1 4.6 2.5c-.9.6-1.6 1.2-1.6 2.3 M10 17.5h.01" />
              <span className="flex-1 text-left">Help Center</span>
            </button>
          </li>
        </ul>
      </nav>

      <div className="rounded-md border border-line bg-surface p-3">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${profile?.online ? 'bg-green' : 'bg-amber'}`} />
          <span className="text-[11px] font-semibold text-ink">
            {profile?.online ? 'System Online' : profile ? 'Database unreachable' : 'Checking…'}
          </span>
        </div>
        <div className="mt-1 text-[10px] text-slate2">
          {profile?.environment === 'production' ? 'Production' : 'Supabase · Render'}
        </div>
        <div className="mt-0.5 text-[10px] text-slate2">v{APP_VERSION}</div>
      </div>
    </aside>
  );
}
