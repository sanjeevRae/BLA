// Thin wrapper around the FastAPI backend.
import { supabase } from './supabase';

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000';

async function request(path, options = {}) {
  // Attach the Supabase session token when signed in (needed for role-guarded
  // endpoints when REQUIRE_AUTH=true in production).
  let authHeader = {};
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (token) authHeader = { Authorization: `Bearer ${token}` };
  } catch {
    // ignore — call still works in dev (auth disabled)
  }
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...authHeader, ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

export const api = {
  listOrders: (status) =>
    request(`/orders${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  listCustomers: (q) => request(`/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  createCustomer: (payload) =>
    request('/customers', { method: 'POST', body: JSON.stringify(payload) }),
  updateCustomer: (id, payload) =>
    request(`/customers/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteCustomer: (id) => request(`/customers/${id}`, { method: 'DELETE' }),
  createOrder: (payload) =>
    request('/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateOrder: (orderId, payload) =>
    request(`/orders/${orderId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteOrder: (orderId) =>
    request(`/orders/${orderId}`, {
      method: 'DELETE',
    }),
  getOrderAssignment: (orderId) => request(`/orders/${orderId}/assignment`),
  listDrivers: (availableOnly = false) =>
    request(`/drivers${availableOnly ? '?available_only=true' : ''}`),
  getOverview: () => request('/analytics/overview'),
  getCashflow: () => request('/analytics/cashflow'),
  getAdminFeed: () => request('/analytics/admin-feed'),
  getTrends: (days = 7) => request(`/analytics/trends?days=${days}`),
  getRevenue: (days = 7) => request(`/analytics/revenue?days=${days}`),
  getActivity: (limit = 8) => request(`/analytics/activity?limit=${limit}`),
  getPaymentsSummary: () => request('/analytics/payments-summary'),
  assignDriver: (orderId, driverId, vehicleId) =>
    request(`/orders/${orderId}/assign`, {
      method: 'POST',
      body: JSON.stringify({
        order_id: orderId,
        driver_id: driverId,
        vehicle_id: vehicleId,
      }),
    }),
  listWarehouses: () => request('/ops/warehouses'),
  listVehicles: () => request('/ops/vehicles'),
  listInventory: () => request('/ops/inventory'),
  listPayments: () => request('/ops/payments'),
  listPackages: () => request('/ops/packages'),
  // Shell profile: operator identity + per-section counts + system status.
  getProfile: () => request('/ops/profile'),
  // Business vendors (staff read; super-admin write).
  listVendors: (q) => request(`/vendors${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  createVendor: (payload) =>
    request('/vendors', { method: 'POST', body: JSON.stringify(payload) }),
  updateVendor: (id, payload) =>
    request(`/vendors/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  updateOrderStatus: (orderId, status) =>
    request(`/orders/${orderId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  pushGps: (payload) =>
    request('/drivers/gps', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  // ---- Phase 2: parcel lifecycle ----
  listShipments: (status) =>
    request(`/shipments${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  getShipment: (id) => request(`/shipments/${id}`),
  createShipment: (payload) =>
    request('/shipments', { method: 'POST', body: JSON.stringify(payload) }),
  updateShipmentStatus: (id, status, note) =>
    request(`/shipments/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, note }),
    }),
  getShipmentEvents: (id) => request(`/shipments/${id}/events`),
  scanShipment: (id, scan_type, location) =>
    request(`/warehouse/scan/${id}`, {
      method: 'POST',
      body: JSON.stringify({ scan_type, location }),
    }),
  listScans: () => request('/warehouse/scans'),
  listTransfers: () => request('/warehouse/transfers'),
  listHandovers: () => request('/warehouse/handovers'),
  listDriverTasks: () => request('/driver-tasks'),
  listTrips: () => request('/trips'),
  listTripManifest: (tripId) => request(`/trips/${tripId}/manifest`),
};
