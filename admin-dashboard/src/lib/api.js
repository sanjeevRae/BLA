// Thin wrapper around the FastAPI backend.
const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
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
};
