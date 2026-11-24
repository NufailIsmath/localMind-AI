"use client";

import type { AuthResponse } from "@clbuddy/shared";
import { useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";

export function AuthForm({ onAuthenticated }: { onAuthenticated: (auth: AuthResponse) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = mode === "login" ? await api.login(email, password) : await api.register(email, password);
      onAuthenticated(res);
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details)) {
        setError((err.details as { message: string }[]).map((d) => d.message).join(". "));
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="brand brand-lg">
          <span className="brand-mark">CL</span> Buddy
        </div>
        <p className="muted">Your work buddy: answers from company docs, help sorting out work issues, and email drafts. Runs privately on your own machines.</p>

        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={mode === "login"} className={mode === "login" ? "active" : ""} onClick={() => setMode("login")} type="button">
            Sign in
          </button>
          <button role="tab" aria-selected={mode === "register"} className={mode === "register" ? "active" : ""} onClick={() => setMode("register")} type="button">
            Create account
          </button>
        </div>

        <form onSubmit={submit} className="auth-form">
          <label>
            Email
            <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
              minLength={mode === "register" ? 8 : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {mode === "register" && <p className="hint">At least 8 characters. The first account becomes the administrator.</p>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
      </div>
    </main>
  );
}
