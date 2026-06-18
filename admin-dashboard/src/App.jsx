import React, { useCallback, useEffect, useState } from 'react';
import StatsBar from './components/StatsBar';
import OrdersList from './components/OrdersList';
import AssignPanel from './components/AssignPanel';
import LiveMap from './components/LiveMap';
import { supabase } from './lib/supabase';
import { api } from './lib/api';

export default function App() {
  const [stats, setStats] = useState(null);
  const [orders, setOrders] = useState([]);
  const [selected, setSelected] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [ov, list] = await Promise.all([api.getOverview(), api.listOrders()]);
      setStats(ov);
      setOrders(list);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e);
    }
  }, []);

  useEffect(() => {
    refresh();
    // Live-refresh the orders list when order rows change.
    const channel = supabase
      .channel('orders-live')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'orders' },
        () => refresh()
      )
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [refresh]);

  return (
    <div className="flex h-full flex-col bg-slate-100">
      <header className="flex items-center justify-between bg-slate-900 px-4 py-3 text-white">
        <h1 className="text-lg font-bold">BLA — Operations Dashboard</h1>
        <button
          onClick={refresh}
          className="rounded bg-slate-700 px-3 py-1 text-sm hover:bg-slate-600"
        >
          Refresh
        </button>
      </header>

      <div className="p-4">
        <StatsBar stats={stats} />
      </div>

      <main className="grid flex-1 grid-cols-1 gap-4 overflow-hidden px-4 pb-4 lg:grid-cols-[20rem_1fr_18rem]">
        <section className="flex flex-col overflow-hidden rounded-lg bg-white shadow">
          <h2 className="border-b border-slate-100 p-3 text-sm font-semibold text-slate-700">
            Orders
          </h2>
          <OrdersList orders={orders} selectedId={selected?.id} onSelect={setSelected} />
        </section>

        <section className="overflow-hidden rounded-lg bg-white shadow">
          <LiveMap />
        </section>

        <section className="overflow-y-auto rounded-lg bg-white shadow">
          <h2 className="border-b border-slate-100 p-3 text-sm font-semibold text-slate-700">
            Dispatch
          </h2>
          <AssignPanel order={selected} onAssigned={refresh} />
        </section>
      </main>
    </div>
  );
}
