import React, { useState, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import LoginPage from "./components/LoginPage";
import SignupPage from "./components/SignupPage";
import OldAdminDashboard from "./App.jsx";

interface UserInfo {
  role: string;
  email: string;
  full_name: string;
  dashboard_path: string;
}

function getStoredUser(): UserInfo | null {
  const isAuthenticated = localStorage.getItem("bla_is_authenticated");
  if (isAuthenticated !== "true") return null;
  return {
    role: localStorage.getItem("bla_user_role") || "",
    email: localStorage.getItem("bla_user_email") || "",
    full_name: localStorage.getItem("bla_user_full_name") || "",
    dashboard_path: localStorage.getItem("bla_dashboard_path") || "/dashboard",
  };
}

function Dashboard({ user, onLogout }: { user: UserInfo; onLogout: () => void }) {
  const navigate = useNavigate();

  const handleLogout = () => {
    onLogout();
    navigate("/login");
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16 items-center">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-slate-900 flex items-center justify-center">
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <span className="font-bold text-xl text-slate-900 tracking-tight">BLA Admin</span>
            </div>
            <div className="flex items-center gap-4">
              <div className="hidden md:flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-100 text-slate-700 text-sm font-medium">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" /> Online
              </div>
              <span className="text-sm font-medium text-slate-700">{user.full_name || user.email}</span>
              <button
                onClick={handleLogout}
                className="px-4 py-2 rounded-lg bg-red-100 text-red-600 font-medium hover:bg-red-200 transition-colors text-sm"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 mb-1">
              {user.role.charAt(0).toUpperCase() + user.role.slice(1)} Dashboard
            </h1>
            <p className="text-slate-500 text-sm">
              Welcome back, {user.full_name || user.email}! You're logged in as <strong>{user.role}</strong>.
            </p>
          </div>
          <div className="flex items-center gap-3 px-4 py-2 rounded-lg border border-slate-200 bg-white text-sm font-medium text-slate-700">
            <span className="w-2 h-2 rounded-full bg-blue-500" /> {user.dashboard_path}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <div className="bg-white rounded-xl shadow border border-slate-200 p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-500 font-medium uppercase tracking-wider">User Role</p>
                <p className="text-2xl font-bold text-slate-900 mt-1">{user.role}</p>
              </div>
              <div className="w-12 h-12 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0zM12 9v1m0 1v.01" />
                </svg>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow border border-slate-200 p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-500 font-medium uppercase tracking-wider">Dashboard Path</p>
                <p className="text-lg font-bold text-slate-900 mt-1 truncate">{user.dashboard_path}</p>
              </div>
              <div className="w-12 h-12 rounded-lg bg-green-50 flex items-center justify-center text-green-600">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow border border-slate-200 p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-500 font-medium uppercase tracking-wider">Status</p>
                <p className="text-lg font-bold text-slate-900 mt-1">Active</p>
              </div>
              <div className="w-12 h-12 rounded-lg bg-green-50 flex items-center justify-center text-green-600">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow border border-slate-200 p-6 mt-8">
          <h2 className="text-lg font-bold text-slate-900 mb-4">Quick Actions</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <button className="px-6 py-3 rounded-lg border border-slate-300 bg-white text-slate-700 font-medium hover:bg-slate-50 transition-colors text-sm">
              View Orders
            </button>
            <button className="px-6 py-3 rounded-lg border border-slate-300 bg-white text-slate-700 font-medium hover:bg-slate-50 transition-colors text-sm">
              Manage Drivers
            </button>
            <button className="px-6 py-3 rounded-lg border border-slate-300 bg-white text-slate-700 font-medium hover:bg-slate-50 transition-colors text-sm">
              Track Shipments
            </button>
            <button className="px-6 py-3 rounded-lg border border-slate-300 bg-white text-slate-700 font-medium hover:bg-slate-50 transition-colors text-sm">
              Settings
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check localStorage on mount
    const storedUser = getStoredUser();
    setUser(storedUser);
    setLoading(false);

    // Listen for localStorage changes (e.g. login from another tab/window)
    const onAuthChanged = () => {
      const storedUser = getStoredUser();
      setUser(storedUser);
      setLoading(false);
    };

    window.addEventListener("storage", onAuthChanged);
    window.addEventListener("auth-changed", onAuthChanged);
    return () => {
      window.removeEventListener("storage", onAuthChanged);
      window.removeEventListener("auth-changed", onAuthChanged);
    };
  }, []);

  const handleLogout = () => {
    localStorage.removeItem("bla_is_authenticated");
    localStorage.removeItem("bla_user_role");
    localStorage.removeItem("bla_user_email");
    localStorage.removeItem("bla_user_full_name");
    localStorage.removeItem("bla_dashboard_path");
    setUser(null);
    window.location.href = "/login";
  };

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh" }}>
        <p>Loading...</p>
      </div>
    );
  }

  // Admin/super_admin roles get the full old admin dashboard
  const isAdminRole = user?.role === "super_admin" || user?.role === "admin";

  return (
    <BrowserRouter>
      <Routes>
        {!user ? (
          <>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/" element={<Navigate to="/login" replace />} />
          </>
        ) : (
          <>
            <Route path="/login" element={<Navigate to={user.dashboard_path} replace />} />
            <Route path="/" element={<Navigate to={user.dashboard_path} replace />} />

            {/* Admin/super_admin → full old admin dashboard */}
            {isAdminRole ? (
              <>
                <Route path={user.dashboard_path} element={<OldAdminDashboard onLogout={handleLogout} />} />
                <Route path="/super-admin-dashboard" element={<OldAdminDashboard onLogout={handleLogout} />} />
                <Route path="/admin-dashboard" element={<OldAdminDashboard onLogout={handleLogout} />} />
              </>
            ) : (
              <>
                <Route path={user.dashboard_path} element={<Dashboard user={user} onLogout={handleLogout} />} />
                <Route path="/super-admin-dashboard" element={<Dashboard user={user} onLogout={handleLogout} />} />
                <Route path="/admin-dashboard" element={<Dashboard user={user} onLogout={handleLogout} />} />
              </>
            )}

            {/* Other roles → simple dashboard */}
            <Route path="/vendor-portal" element={<Dashboard user={user} />} />
            <Route path="/driver-app" element={<Dashboard user={user} />} />
            <Route path="/customer-tracking" element={<Dashboard user={user} />} />
            <Route path="/warehouse-dashboard" element={<Dashboard user={user} />} />
            <Route path="/dispatcher-dashboard" element={<Dashboard user={user} />} />
          </>
        )}
      </Routes>
    </BrowserRouter>
  );
}

export default App;