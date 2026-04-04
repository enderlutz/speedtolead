import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, setToken } from "@/lib/api";
import { Zap } from "lucide-react";

export default function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirectTo = searchParams.get("redirect") || "/";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { token } = await api.login(username, password);
      setToken(token);
      navigate(redirectTo);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "#0f172a" }}
    >
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div
            className="h-10 w-10 rounded-xl flex items-center justify-center"
            style={{ background: "#0693e3" }}
          >
            <Zap className="h-5 w-5 text-white" />
          </div>
          <div>
            <p className="font-bold text-white text-base leading-none">AT-System</p>
            <p className="text-xs mt-0.5" style={{ color: "#8ed1fc" }}>
              Fence Restoration
            </p>
          </div>
        </div>

        <div
          className="rounded-2xl p-8"
          style={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.08)" }}
        >
          <h1 className="text-xl font-bold text-white mb-1">Sign in</h1>
          <p className="text-sm mb-6" style={{ color: "#94a3b8" }}>
            Enter your username and password to continue.
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                className="block text-sm font-medium mb-1.5"
                style={{ color: "#cbd5e1" }}
              >
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                required
                className="w-full rounded-lg px-4 py-2.5 text-sm outline-none transition-colors"
                style={{
                  background: "#0f172a",
                  border: "1px solid rgba(255,255,255,0.12)",
                  color: "#f1f5f9",
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = "#0693e3")}
                onBlur={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.12)")}
              />
            </div>

            <div>
              <label
                className="block text-sm font-medium mb-1.5"
                style={{ color: "#cbd5e1" }}
              >
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                className="w-full rounded-lg px-4 py-2.5 text-sm outline-none transition-colors"
                style={{
                  background: "#0f172a",
                  border: "1px solid rgba(255,255,255,0.12)",
                  color: "#f1f5f9",
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = "#0693e3")}
                onBlur={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.12)")}
              />
            </div>

            {error && (
              <p
                className="text-sm rounded-lg px-3 py-2"
                style={{ color: "#fca5a5", background: "rgba(239,68,68,0.1)" }}
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-lg text-sm font-semibold text-white transition-opacity"
              style={{
                background: "#0693e3",
                opacity: loading ? 0.7 : 1,
                cursor: loading ? "not-allowed" : "pointer",
              }}
            >
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
