import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, setToken } from "@/lib/api";
import { Eye, EyeOff } from "lucide-react";

export default function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirectTo = searchParams.get("redirect") || "/";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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
      style={{ background: "#15130F" }}
    >
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-8 justify-center">
          {/* The wordmark reversed out, straight on the charcoal. */}
          <img
            src="/sterling-logo-dark.png"
            alt="Sterling Fence Staining"
            className="h-16 w-auto"
            style={{ filter: "drop-shadow(0 4px 14px rgba(0,0,0,0.6))" }}
            draggable={false}
          />
        </div>

        <div
          className="rounded-2xl p-8"
          style={{ background: "#201C16", border: "1px solid rgba(201,151,47,0.25)" }}
        >
          <h1 className="text-xl font-bold text-white mb-1">Sign in</h1>
          <p className="text-sm mb-6" style={{ color: "#9A917F" }}>
            Enter your username and password to continue.
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                className="block text-sm font-medium mb-1.5"
                style={{ color: "#D8D2C4" }}
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
                  background: "#0F0E0B",
                  border: "1px solid rgba(255,255,255,0.12)",
                  color: "#F8F3E7",
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = "#C9972F")}
                onBlur={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.12)")}
              />
            </div>

            <div>
              <label
                className="block text-sm font-medium mb-1.5"
                style={{ color: "#D8D2C4" }}
              >
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                  className="w-full rounded-lg px-4 py-2.5 pr-11 text-sm outline-none transition-colors"
                  style={{
                    background: "#0F0E0B",
                    border: "1px solid rgba(255,255,255,0.12)",
                    color: "#F8F3E7",
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = "#C9972F")}
                  onBlur={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.12)")}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute right-3 top-1/2 -translate-y-1/2"
                  style={{ color: "#9A917F" }}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
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
              className="w-full py-2.5 rounded-lg text-sm font-semibold transition-opacity"
              style={{
                background: "linear-gradient(135deg, #E3BE63, #B4823B)",
                color: "#15130F",
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
