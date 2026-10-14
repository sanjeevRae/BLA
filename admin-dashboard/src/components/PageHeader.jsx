import React from 'react';

// Section header used above every list page: eyebrow + title on white.
export default function PageHeader({ eyebrow, title, description, actions }) {
  return (
    <div className="px-6 pt-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
            {eyebrow}
          </p>
          <h1 className="mt-1 text-[22px] font-bold leading-tight text-ink">{title}</h1>
          {description ? (
            <p className="mt-1 max-w-2xl text-[13px] text-slate2">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
