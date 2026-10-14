import React from 'react';

export default function TopBar({ search, onSearchChange, dateLabel, operator, notifCount = 0 }) {
  const displayName = operator?.name ?? 'Loading…';
  const displayRole = operator?.role ?? '';
  const initials = operator?.initials ?? '—';
  return (
    <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3 lg:px-6">
      <div className="relative w-full max-w-[320px]">
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" />
            <line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </span>
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search orders, customers, phone, city..."
          aria-label="Search orders and customers"
          className="h-10 w-full rounded-md bg-[#F1F5F9] pl-10 pr-3 text-[13px] text-ink placeholder:text-slate2/70 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand/30"
        />
      </div>

      <div className="ml-auto flex items-center gap-2.5">
        <button
          type="button"
          className="hidden h-10 items-center gap-2 rounded-md border border-line bg-surface px-3 text-[13px] text-slate2 transition hover:border-slate2 sm:flex"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
            <line x1="2" y1="6.5" x2="14" y2="6.5" stroke="currentColor" strokeWidth="1.4" />
            <line x1="5.5" y1="1.5" x2="5.5" y2="4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <line x1="10.5" y1="1.5" x2="10.5" y2="4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          {dateLabel ?? ''}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M2.5 4L5 6.5L7.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>

        <button
          type="button"
          aria-label="Notifications"
          className="relative flex h-10 w-10 items-center justify-center rounded-md border border-line bg-surface text-slate2 transition hover:border-slate2"
        >
          <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M6 16v-5a4 4 0 1 1 8 0v5l1.5 2h-11z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M8.5 19.5a1.5 1.5 0 0 0 3 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          {notifCount > 0 ? (
            <span className="absolute right-2.5 top-2.5 h-1.5 w-1.5 rounded-full bg-red" />
          ) : null}
        </button>

        <div className="hidden items-center gap-2 sm:flex">
          <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-cream text-sm font-bold text-brand">
            {initials}
          </span>
          <div className="leading-tight">
            <div className="text-[13px] font-semibold text-ink">{displayName}</div>
            <div className="text-[11px] text-slate2">{displayRole}</div>
          </div>
        </div>
      </div>
    </header>
  );
}


