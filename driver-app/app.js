/* BLA Driver app — plain JS, no framework.
 *
 * Micro drivers: task list (accept → picked up → out for delivery → delivered
 * with COD collection). Big drivers: active trip with status advances and
 * checkpoints. GPS toggle streams position to /drivers/gps (big drivers appear
 * on the admin live map; micro drivers do not).
 */
(function () {
  const cfg = window.BLA_CONFIG || {};
  const BASE = cfg.API_BASE_URL || 'http://localhost:8000';

  const sb =
    cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY
      ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
      : null;

  const TASK_FLOW = ['pending', 'accepted', 'picked_up', 'out_for_delivery', 'delivered'];
  const TRIP_FLOW = ['assigned', 'loading', 'departed', 'at_checkpoint', 'arrived_dest', 'unloading', 'completed'];
  const TASK_LABELS = {
    accepted: 'Accept task',
    picked_up: 'Pick up',
    out_for_delivery: 'Start delivery',
    delivered: 'Mark delivered',
    delivery_failed: 'Report failed',
    returned: 'Return to hub',
  };
  const TRIP_LABELS = {
    loading: 'Start loading',
    departed: 'Depart',
    at_checkpoint: 'At checkpoint',
    arrived_dest: 'Arrived at dest',
    unloading: 'Start unloading',
    completed: 'Complete trip',
  };

  // --- elements -------------------------------------------------------------
  const loginView = document.getElementById('login-view');
  const appView = document.getElementById('app-view');
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  const whoEl = document.getElementById('who');
  const content = document.getElementById('content');
  const roleBadge = document.getElementById('role-badge');
  const gpsBtn = document.getElementById('gps');
  const signoutBtn = document.getElementById('signout');

  let session = null;
  let driver = null;
  let watchId = null;

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );

  const nextOf = (flow, cur) => {
    const i = flow.indexOf(cur);
    return i === -1 || i === flow.length - 1 ? null : flow[i + 1];
  };

  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (session && session.access_token) headers.Authorization = `Bearer ${session.access_token}`;
    const res = await fetch(`${BASE}${path}`, { ...options, headers });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }

  function showLogin(msg) {
    loginView.classList.remove('hidden');
    appView.classList.add('hidden');
    roleBadge.classList.add('hidden');
    gpsBtn.classList.add('hidden');
    signoutBtn.classList.add('hidden');
    loginError.hidden = !msg;
    if (msg) loginError.textContent = msg;
  }

  // --- auth -----------------------------------------------------------------
  if (sb) {
    sb.auth.getSession().then(({ data }) => {
      if (data.session) onSession(data.session);
      else showLogin();
    });
    sb.auth.onAuthStateChange((_event, s) => {
      if (s) onSession(s);
      else showLogin();
    });
  } else {
    showLogin('Supabase config missing in config.js');
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.hidden = true;
    try {
      const { error } = await sb.auth.signInWithPassword({
        email: document.getElementById('email').value.trim(),
        password: document.getElementById('password').value,
      });
      if (error) showLogin(error.message);
    } catch (err) {
      showLogin(String(err.message || err));
    }
  });

  document.getElementById('login-form').insertAdjacentHTML(
    'afterend',
    '<p style="margin-top:10px"><a href="#" id="dev-skip">Continue without login (dev only)</a></p>',
  );
  document.getElementById('dev-skip').addEventListener('click', async (e) => {
    e.preventDefault();
    session = null;
    try {
      const drivers = await api('/drivers');
      if (!drivers.length) throw new Error('No drivers exist yet.');
      driver = drivers.find((d) => d.driver_type === 'big') || drivers[0];
      showApp();
    } catch (err) {
      showLogin(err.message || String(err));
    }
  });

  signoutBtn.addEventListener('click', async () => {
    if (sb) await sb.auth.signOut();
    session = null;
    driver = null;
    showLogin();
  });

  async function onSession(s) {
    session = s;
    try {
      const drivers = await api('/drivers');
      driver = drivers.find((d) => d.user_id && String(d.user_id) === String(s.user.id)) || null;
      if (!driver) {
        showLogin('No driver profile is linked to this account yet.');
        return;
      }
      showApp();
    } catch (err) {
      showLogin(`Failed to load driver profile: ${err.message || err}`);
    }
  }

  function showApp() {
    loginView.classList.add('hidden');
    appView.classList.remove('hidden');
    roleBadge.classList.remove('hidden');
    gpsBtn.classList.remove('hidden');
    signoutBtn.classList.remove('hidden');
    const big = driver.driver_type === 'big';
    roleBadge.textContent = big ? 'Big driver' : 'Micro driver';
    roleBadge.classList.toggle('big', big);
    render().catch((err) => {
      whoEl.textContent = `Failed to load: ${err.message || err}`;
    });
  }

  async function render() {
    if (driver.driver_type === 'big') await renderTrip();
    else await renderTasks();
  }

  // --- micro driver: tasks ---------------------------------------------------
  async function renderTasks() {
    const tasks = await api(`/driver-tasks?driver_id=${driver.id}&active_only=true`);
    whoEl.textContent = tasks.length
      ? `${tasks.length} active task${tasks.length > 1 ? 's' : ''}`
      : 'No active tasks — you are clear.';
    if (!tasks.length) {
      content.innerHTML = '<div class="card muted">New assignments will appear here.</div>';
      return;
    }
    content.innerHTML = tasks.map(taskCard).join('');
  }

  function taskCard(t) {
    const s = t.shipments || {};
    const next = nextOf(TASK_FLOW, t.status);
    const canFail = t.status === 'out_for_delivery';
    const codBlock = t.cod_required
      ? `<div class="row"><span class="muted">COD due</span>
         <span class="cod">${Number(t.cod_amount || 0)}</span></div>` +
        (next === 'delivered'
          ? `<input data-cod="${esc(t.id)}" type="number" inputmode="decimal"
               placeholder="COD collected amount" value="${Number(t.cod_amount || 0)}">`
          : '')
      : '';
    return `
      <div class="card stack">
        <div class="row">
          <span class="pill">${esc(t.task_type)}</span>
          <span class="pill">${esc(t.status)}</span>
        </div>
        <div>
          <strong>${esc(s.tracking_code || 'Parcel')}</strong>
          <div class="muted">${esc(s.recipient_name || '')} — ${esc(s.destination_address || '')}</div>
          <div class="muted">Parcel: ${esc(s.parcel_status || '')}</div>
        </div>
        ${codBlock}
        <div class="actions">
          ${next ? `<button class="primary" data-task="${esc(t.id)}" data-status="${next}">${TASK_LABELS[next] || next}</button>` : ''}
          ${canFail ? `<button data-task="${esc(t.id)}" data-status="delivery_failed">${TASK_LABELS.delivery_failed}</button>` : ''}
        </div>
      </div>`;
  }

  // --- big driver: trip ------------------------------------------------------
  async function renderTrip() {
    const trips = await api(`/trips?driver_id=${driver.id}&active_only=true`);
    const t = trips[0];
    if (!t) {
      whoEl.textContent = 'No active trip';
      content.innerHTML = '<div class="card muted">New trips assigned to you will appear here.</div>';
      return;
    }
    whoEl.textContent = 'Active trip';
    const next = nextOf(TRIP_FLOW, t.status);
    content.innerHTML = `
      <div class="card stack">
        <div class="row">
          <span class="pill">trip ${esc(String(t.id).slice(0, 8))}</span>
          <span class="pill">${esc(t.status)}</span>
        </div>
        <div class="muted">
          Departed: ${esc(t.departed_at || '—')} · Arrived: ${esc(t.arrived_at || '—')}
        </div>
        <div class="actions">
          ${next ? `<button class="primary" data-trip="${esc(t.id)}" data-status="${next}">${TRIP_LABELS[next] || next}</button>` : ''}
          ${t.status !== 'cancelled' && t.status !== 'completed'
            ? `<button data-trip="${esc(t.id)}" data-status="cancelled">Cancel trip</button>`
            : ''}
        </div>
        <div class="row">
          <input id="checkpoint-label" placeholder="Checkpoint label (e.g. Butwal toll)">
          <button data-checkpoint="${esc(t.id)}">Add</button>
        </div>
      </div>`;
  }



  // --- shared action handling -----------------------------------------------
  content.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-status]');
    if (!btn) return;
    const status = btn.dataset.status;
    btn.disabled = true;
    try {
      if (btn.dataset.task) {
        let cod = 0;
        const codInput = content.querySelector(`[data-cod="${btn.dataset.task}"]`);
        if (status === 'delivered' && codInput) cod = Number(codInput.value || 0);
        await api(
          `/driver-tasks/${btn.dataset.task}/status?status=${encodeURIComponent(status)}&cod_collected=${cod}`,
          { method: 'PATCH' },
        );
        await renderTasks();
      } else if (btn.dataset.trip) {
        await api(`/trips/${btn.dataset.trip}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status }),
        });
        await renderTrip();
      }
      whoEl.textContent = `Updated to ${String(status).replace(/_/g, ' ')}`;
    } catch (err) {
      whoEl.textContent = `Action failed: ${err.message || err}`;
      btn.disabled = false;
    }
  });

  content.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-checkpoint]');
    if (!btn) return;
    const input = document.getElementById('checkpoint-label');
    const label = (input.value || '').trim();
    if (!label) return;
    btn.disabled = true;
    try {
      await api(`/trips/${btn.dataset.checkpoint}/checkpoints`, {
        method: 'POST',
        body: JSON.stringify({ label }),
      });
      input.value = '';
      whoEl.textContent = `Checkpoint “${label}” recorded`;
    } catch (err) {
      whoEl.textContent = `Checkpoint failed: ${err.message || err}`;
    } finally {
      btn.disabled = false;
    }
  });

  // --- GPS: one location ping every 5 minutes --------------------------------
  const PING_MS = 5 * 60 * 1000; // spec: big drivers report every 5 min

  function sendPing() {
    if (!driver || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        api('/drivers/gps', {
          method: 'POST',
          body: JSON.stringify({
            driver_id: driver.id,
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy_m: pos.coords.accuracy,
            speed_kmh: pos.coords.speed != null ? pos.coords.speed * 3.6 : null,
          }),
        })
          .then(() => {
            const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            whoEl.textContent = `Location sent at ${t} · next ping in 5 min`;
          })
          .catch(() => {});
      },
      () => {
        whoEl.textContent = 'Location permission denied';
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  }

  gpsBtn.addEventListener('click', () => {
    if (watchId != null) {
      clearInterval(watchId);
      watchId = null;
      gpsBtn.textContent = 'GPS off';
      gpsBtn.classList.remove('on');
      return;
    }
    if (!driver || !navigator.geolocation) {
      whoEl.textContent = 'GPS unavailable';
      return;
    }
    sendPing(); // immediate first ping
    watchId = setInterval(sendPing, PING_MS); // then every 5 minutes
    gpsBtn.textContent = 'GPS · 5 min';
    gpsBtn.classList.add('on');
    whoEl.textContent = 'GPS on — sending location every 5 minutes';
  });
})();
