import React, { useState } from "react";
import { useNavigate } from "react-router-dom";

interface LoginFormValues {
  email: string;
  password: string;
}

interface LoginResponse {
  role: string;
  email: string | null;
  full_name: string | null;
  dashboard_path: string;
  access: "granted" | "denied";
  reason?: string;
  detail?: string;
}

const LoginPage: React.FC = () => {
  const [form, setForm] = useState<LoginFormValues>({
    email: "",
    password: "",
  });
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: form.email,
          password: form.password,
        }),
      });

      const data: LoginResponse = await response.json();

      if (!response.ok || data.access === "denied") {
        setError(data.detail || data.reason || "Login failed");
        setLoading(false);
        return;
      }

      // Store auth state in localStorage
      localStorage.setItem("bla_is_authenticated", "true");
      localStorage.setItem("bla_user_role", data.role);
      localStorage.setItem("bla_user_email", data.email || "");
      localStorage.setItem("bla_user_full_name", data.full_name || "");
      localStorage.setItem("bla_dashboard_path", data.dashboard_path);

      // Notify parent app that auth state changed (same-tab navigation)
      window.dispatchEvent(new Event("auth-changed"));

      const dashboardPath = data.dashboard_path;
      if (dashboardPath) {
        navigate(dashboardPath);
      } else {
        setError("No dashboard configured for your role - contact administrator");
      }
    } catch (err) {
      setError("Network error or server unavailable");
    } finally {
      setLoading(false);
    }
  };

  const handleSignup = () => {
    navigate("/signup");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="max-w-md w-full">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-slate-900">BLA Admin</h1>
          <p className="text-slate-500 text-sm">Sign in to your account</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden p-8">
        <form onSubmit={handleSubmit} className="space-y-5 mt-0">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-700">
                  Email Address
                </label>
                <input
                  type="email"
                  required
                  className="w-full px-4 py-3 rounded-lg border border-slate-300 text-slate-900 placeholder-slate-400 focus:ring-2 focus:ring-slate-900 focus:border-slate-900 outline-none transition-all disabled:opacity-70 disabled:cursor-not-allowed"
                  placeholder="name@company.com"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  disabled={loading}
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-700">
                  Password
                </label>
                <input
                  type="password"
                  required
                  className="w-full px-4 py-3 rounded-lg border border-slate-300 text-slate-900 placeholder-slate-400 focus:ring-2 focus:ring-slate-900 focus:border-slate-900 outline-none transition-all disabled:opacity-70 disabled:cursor-not-allowed"
                  placeholder="••••••••"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  disabled={loading}
                />
              </div>

              {error && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-100 text-red-700 text-sm">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={!form.email || !form.password || loading}
                className="w-full py-4 px-4 rounded-lg bg-slate-900 text-white font-semibold text-lg hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all active:scale-[0.98]"
              >
                {loading ? "Signing in…" : "Sign in"}
              </button>
            </form>

          <div className="mt-6 pt-4 border-t border-slate-100 flex items-center justify-between">
            <div className="text-sm text-slate-600">
              Don't have an account?
            </div>
            <button
              onClick={handleSignup}
              className="text-sm font-medium text-slate-900 hover:text-slate-600 underline hover:underline transition-colors"
            >
              Sign up
            </button>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          © {new Date().getFullYear()} BLA Operations Dashboard
        </p>
      </div>
    </div>
  );
};

export default LoginPage;