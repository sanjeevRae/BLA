/* BLA Vendor portal — plain JS.
 *
 * Register parcels (vendor JWT stamps vendor_id server-side), view own
 * parcels and settlements (both auto-scoped by the backend to the vendor).
 */
(function () {
  const cfg = window.BLA_CONFIG || {};
  const BASE = cfg.API_BASE_URL || 'http://localhost:8000';

  const sb =
    cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY
      ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
      : null;

  const loginView = document.getElementById('login-view');
  const appView = document.getElementById('app-view');
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  const signoutBtn = document.getElementById('signout');
  const msgEl = document.getElementById('msg');
  const parcelsEl = document.getElementById('parcels');
  const settlementsEl = document.getElementById('settlements');
  const registerForm = document.getElementById('register-form');
  const submitBtn = document.getElementById('r-submit');

  let session = null;

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );

  const fmtDate = (v) => {
    if (!v) return '—';
    try {
      return new Date(v).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
    } catch {
      return String(v);
    }
  };

  const fmtMoney = (v) =>
    `Rs. ${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
      .format(Number(v || 0))}`;

  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (session && session.access_token) headers.Authorization = `Bearer ${session.access_token}`;
    const res = await fetch(`${BASE}${path}`, { ...options, headers });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }

  function showLogin(err) {
    loginView.classList.remove('hidden');
    appView.classList.add('hidden');
    signoutBtn.classList.add('hidden');
    loginError.hidden = !err;
    if (err) loginError.textContent = err;
  }

  function showApp() {
    loginView.classList.add('hidden');
    appView.classList.remove('hidden');
    signoutBtn.classList.remove('hidden');
    renderAll().catch((e) => {
      msgEl.hidden = false;
      msgEl.textContent = `Failed to load: ${e.message || e}`;
    });
  }

  // --- auth -----------------------------------------------------------------
  if (sb) {
    sb.auth.getSession().then(({ data }) => {
      if (data.session) {
        session = data.session;
        showApp();
      } else showLogin();
    });
    sb.auth.onAuthStateChange((_e, s) => {
      session = s;
      if (s) showApp();
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

  document.getElementById('dev-skip').addEventListener('click', (e) => {
    e.preventDefault();
    session = null;
    showApp();
  });

  signoutBtn.addEventListener('click', async () => {
    if (sb) await sb.auth.signOut();
    session = null;
    showLogin();
  });

  // --- rendering -------------------------------------------------------------
  async function renderAll() {
    const [parcels, settlements] = await Promise.all([
      api('/shipments').catch(() => []),
      api('/settlements').catch(() => []),
    ]);
    renderParcels(parcels);
    renderSettlements(settlements);
  }

  function renderParcels(rows) {
    if (!rows.length) {
      parcelsEl.innerHTML = '<p class="muted">No parcels yet — register your first above.</p>';
      return;
    }
    parcelsEl.innerHTML = rows
      .map(
        (r) => `
      <div class="rowitem">
        <div>
          <span class="mono">${esc(r.tracking_code)}</span>
          <div class="muted">${esc(r.recipient_name || '')} — ${esc(r.destination_address || '')}</div>
          <div class="muted">Registered ${fmtDate(r.created_at)}</div>
        </div>
        <span class="pill ${r.parcel_status === 'delivered' ? 'ok' : ''}">${esc(r.parcel_status)}</span>
      </div>`,
      )
      .join('');
  }

  function renderSettlements(rows) {
    if (!rows.length) {
      settlementsEl.innerHTML = '<p class="muted">No settlements yet.</p>';
      return;
    }
    settlementsEl.innerHTML = rows
      .map(
        (r) => `
      <div class="rowitem">
        <div>
          <strong>${fmtDate(r.period_start)} → ${fmtDate(r.period_end)}</strong>
          <div class="muted">Gross ${fmtMoney(r.gross_amount)} · Deductions ${fmtMoney(r.deductions)}</div>
        </div>
        <div style="text-align:right">
          <span class="net">${fmtMoney(r.net_amount)}</span>
          <div><span class="pill ${r.status === 'settled' ? 'ok' : ''}">${esc(r.status)}</span></div>
        </div>
      </div>`,
      )
      .join('');
  }

  // --- register parcel -------------------------------------------------------
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    msgEl.hidden = true;
    try {
      const payload = {
        destination_address: document.getElementById('r-address').value.trim(),
        recipient_name: document.getElementById('r-recipient').value.trim() || undefined,
        recipient_phone: document.getElementById('r-phone').value.trim() || undefined,
        weight_kg: Number(document.getElementById('r-weight').value || 0),
        declared_value: Number(document.getElementById('r-value').value || 0),
      };
      const shipment = await api('/shipments', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      registerForm.reset();
      msgEl.style.color = 'var(--pos)';
      msgEl.hidden = false;
      msgEl.textContent = `Registered ${shipment.tracking_code}`;
      await renderAll();
    } catch (err) {
      msgEl.style.color = 'var(--red)';
      msgEl.hidden = false;
      msgEl.textContent = `Registration failed: ${err.message || err}`;
    } finally {
      submitBtn.disabled = false;
    }
  });
})();

