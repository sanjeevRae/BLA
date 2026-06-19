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
  getOrderAssignment: (orderId) => request(`/orders/${orderId}/assignment`),
  listDrivers: (availableOnly = false) =>
    request(`/drivers${availableOnly ? '?available_only=true' : ''}`),
  getOverview: () => request('/analytics/overview'),
  assignDriver: (orderId, driverId, vehicleId) =>
    request(`/orders/${orderId}/assign`, {
      method: 'POST',
      body: JSON.stringify({
        order_id: orderId,
        driver_id: driverId,
        vehicle_id: vehicleId,
      }),
    }),
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
