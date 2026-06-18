/* BLA customer tracking — plain JS, no framework.
 *
 * Flow:
 *   1. Customer enters an order number.
 *   2. We look up the order via the FastAPI backend (or Supabase directly) to
 *      get its id + current status.
 *   3. We render the status progression (received -> ... -> delivered).
 *   4. We subscribe to Supabase Realtime:
 *        - gps_tracking INSERTs for that order -> move the driver marker
 *        - delivery_status_history INSERTs for that order -> update the steps
 */
(function () {
  const cfg = window.BLA_CONFIG || {};
  const STATUS_FLOW = [
    'received',
    'on_place',
    'went_for_delivery',
    'out_for_delivery',
    'delivered',
  ];

  // --- Elements ------------------------------------------------------------
  const form = document.getElementById('lookup');
  const input = document.getElementById('tracking-input');
  const errorEl = document.getElementById('error');
  const resultEl = document.getElementById('result');
  const orderNumberEl = document.getElementById('order-number');
  const badgeEl = document.getElementById('status-badge');
  const etaEl = document.getElementById('eta');

  // --- Clients -------------------------------------------------------------
  const sb =
    cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY
      ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
      : null;

  let map = null;
  let driverMarker = null;
  let channel = null;

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }
  function clearError() {
    errorEl.hidden = true;
  }

  function renderProgress(status) {
    const idx = STATUS_FLOW.indexOf(status);
    document.querySelectorAll('#progress li').forEach((li) => {
      const i = STATUS_FLOW.indexOf(li.dataset.step);
      li.classList.remove('done', 'current');
      if (i < idx) li.classList.add('done');
      else if (i === idx) li.classList.add('current');
    });
    badgeEl.textContent = status.replace(/_/g, ' ');
  }

  function ensureMap(lng, lat) {
    if (!cfg.MAPTILER_API_KEY) return;
    if (!map) {
      maptilersdk.config.apiKey = cfg.MAPTILER_API_KEY;
      map = new maptilersdk.Map({
        container: 'map',
        style: maptilersdk.MapStyle.STREETS,
        center: [lng, lat],
        zoom: 13,
      });
      driverMarker = new maptilersdk.Marker({ color: '#2563eb' })
        .setLngLat([lng, lat])
        .addTo(map);
    } else {
      driverMarker.setLngLat([lng, lat]);
      map.easeTo({ center: [lng, lat] });
    }
  }

  async function lookupOrder(orderNumber) {
    // Prefer Supabase direct read (RLS allows public status read for tracking).
    if (sb) {
      const { data, error } = await sb
        .from('orders')
        .select('id, order_number, status, delivery_latitude, delivery_longitude')
        .eq('order_number', orderNumber)
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    }
    // Fallback: backend API.
    const res = await fetch(`${cfg.API_BASE_URL}/orders?status=`);
    if (!res.ok) throw new Error('Lookup failed');
    const list = await res.json();
    return list.find((o) => o.order_number === orderNumber) || null;
  }

  async function loadLatestGps(orderId) {
    if (!sb) return;
    const { data } = await sb
      .from('gps_tracking')
      .select('latitude, longitude')
      .eq('order_id', orderId)
      .order('recorded_at', { ascending: false })
      .limit(1);
    if (data && data.length) {
      ensureMap(data[0].longitude, data[0].latitude);
    }
  }

  function subscribe(orderId) {
    if (!sb) return;
    if (channel) sb.removeChannel(channel);
    channel = sb
      .channel(`track-${orderId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'gps_tracking',
          filter: `order_id=eq.${orderId}`,
        },
        (payload) => ensureMap(payload.new.longitude, payload.new.latitude)
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'delivery_status_history',
          filter: `order_id=eq.${orderId}`,
        },
        (payload) => renderProgress(payload.new.status)
      )
      .subscribe();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const orderNumber = input.value.trim();
    if (!orderNumber) return;
    try {
      const order = await lookupOrder(orderNumber);
      if (!order) {
        resultEl.hidden = true;
        showError('No order found with that number.');
        return;
      }
      orderNumberEl.textContent = order.order_number;
      renderProgress(order.status);
      etaEl.textContent =
        order.status === 'delivered'
          ? 'Delivered. Thank you!'
          : 'Tracking live — this page updates automatically.';
      resultEl.hidden = false;

      await loadLatestGps(order.id);
      subscribe(order.id);
    } catch (err) {
      showError(err.message || 'Something went wrong.');
    }
  });

  // Allow deep-linking: ?order=BLA-2026-0002
  const params = new URLSearchParams(window.location.search);
  const pre = params.get('order');
  if (pre) {
    input.value = pre;
    form.dispatchEvent(new Event('submit'));
  }
})();
