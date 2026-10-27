import React, { useState } from "react";
import { useNavigate } from "react-router-dom";

interface SignupFormValues {
  full_name: string;
  email: string;
  password: string;
}

interface SignupResponse {
  access: "granted" | "denied";
  role: string;
  email: string;
  full_name: string;
  dashboard_path: string;
  detail: string;
  reason?: string;
}

const SignupPage: React.FC = () => {
  const [form, setForm] = useState<SignupFormValues>({
    full_name: "",
    email: "",
    password: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          full_name: form.full_name,
          email: form.email,
          password: form.password,
          role: "customer",
        }),
      });

      const data: SignupResponse = await response.json();

      if (!response.ok || data.access === "denied") {
        setError(data.detail || data.reason || "Signup failed");
        setLoading(false);
        return;
      }

      setSuccess(true);
      setLoading(false);

      localStorage.setItem("bla_is_authenticated", "true");
      localStorage.setItem("bla_user_role", data.role);
      localStorage.setItem("bla_user_email", data.email);
      localStorage.setItem("bla_user_full_name", data.full_name);
      localStorage.setItem("bla_dashboard_path", data.dashboard_path);

      setTimeout(() => {
        navigate(data.dashboard_path, { replace: true });
      }, 1500);
    } catch {
      setError("Network error or server unavailable");
      setLoading(false);
    }
  };

  const handleLogin = () => {
    navigate("/login");
  };
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="max-w-md w-full">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-slate-900 mb-4">
            <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">BLA Admin</h1>
          <p className="text-slate-500 text-sm mt-1">Create your account</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden">
          <div className="p-8">
            {!success ? (
              <form onSubmit={handleSubmit} className="space-y-5 mt-0">
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-slate-700">Full Name</label>
                  <input type="text" required className="w-full px-4 py-3 rounded-lg border border-slate-300 text-slate-900 placeholder-slate-400 focus:ring-2 focus:ring-slate-900 focus:border-slate-900 outline-none transition-all disabled:opacity-70 disabled:cursor-not-allowed" placeholder="John Doe" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} disabled={loading} />
                </div>
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-slate-700">Email Address</label>
                  <input type="email" required className="w-full px-4 py-3 rounded-lg border border-slate-300 text-slate-900 placeholder-slate-400 focus:ring-2 focus:ring-slate-900 focus:border-slate-900 outline-none transition-all disabled:opacity-70 disabled:cursor-not-allowed" placeholder="name@company.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} disabled={loading} />
                </div>
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-slate-700">Password</label>
                  <input type="password" required minLength="6" className="w-full px-4 py-3 rounded-lg border border-slate-300 text-slate-900 placeholder-slate-400 focus:ring-2 focus:ring-slate-900 focus:border-slate-900 outline-none transition-all disabled:opacity-70 disabled:cursor-not-allowed" placeholder="••••••••" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} disabled={loading} />
                </div>
                {error && (
                  <div className="p-3 rounded-lg bg-red-50 border border-red-100 text-red-700 text-sm">{error}</div>
                )}
                <button type="submit" disabled={loading} className="w-full py-4 px-4 rounded-lg bg-slate-900 text-white font-semibold text-lg hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all active:scale-[0.98]">{loading ? "Creating account…" : "Create Account"}</button>
              </form>
            ) : (
              <div className="text-center py-10">
                <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                  <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h2 className="text-xl font-bold text-slate-900 mb-2">Account Created!</h2>
                <p className="text-slate-600 mb-6">Redirecting you to customer dashboard…</p>
                <div className="flex justify-center">
                  <span className="px-3 py-1 rounded-full bg-slate-100 text-slate-600 text-xs font-medium animate-pulse">Please wait</span>
                </div>
              </div>
            )}
            <div className="mt-8 pt-6 border-t border-slate-100 text-center">
              <p className="text-sm text-slate-600">Already have an account?{" "}
                <button onClick={handleLogin} className="text-sm font-medium text-slate-900 hover:text-slate-600 underline underline-offset-4 transition-colors">Sign in</button>
              </p>
            </div>
            <p className="mt-6 text-center text-xs text-slate-400">© {new Date().getFullYear()} BLA Operations Dashboard</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SignupPage;