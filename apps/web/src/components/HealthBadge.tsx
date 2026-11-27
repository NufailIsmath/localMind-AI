"use client";

import type { HealthDto } from "@clbuddy/shared";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export function HealthBadge({ token }: { token: string }) {
  const [health, setHealth] = useState<HealthDto | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.health(token).then((h) => alive && setHealth(h)).catch(() => {});
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [token]);
  if (!health) return null;
  const problems = Object.entries(health.checks).filter(([, c]) => !c.ok);
  const title = Object.entries(health.checks)
    .map(([name, c]) => `${name}: ${c.ok ? "ok" : "down"}${c.detail ? ` — ${c.detail}` : ""}`)
    .join("\n");
  return (
    <span className={`health ${health.status === "ok" ? "ok" : "bad"}`} title={title}>
      <span className="dot" aria-hidden />
      {health.status !== "ok"
        ? `${problems.map(([n]) => (n === "ai" ? (health.ai?.label ?? "AI provider") : n)).join(", ")} unavailable`
        : health.ai?.mode === "hosted"
          ? `All systems go · AI by ${health.ai.label ?? "hosted provider"}`
          : "All systems local"}
    </span>
  );
}
