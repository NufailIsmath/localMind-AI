"use client";

import type { HealthDto } from "@localmind/shared";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export function HealthBadge() {
  const [health, setHealth] = useState<HealthDto | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.health().then((h) => alive && setHealth(h)).catch(() => {});
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!health) return null;
  const problems = Object.entries(health.checks).filter(([, c]) => !c.ok);
  const title = Object.entries(health.checks)
    .map(([name, c]) => `${name}: ${c.ok ? "ok" : "down"}${c.detail ? ` — ${c.detail}` : ""}`)
    .join("\n");
  return (
    <span className={`health ${health.status === "ok" ? "ok" : "bad"}`} title={title}>
      <span className="dot" aria-hidden />
      {health.status === "ok" ? "All systems local" : `${problems.map(([n]) => n).join(", ")} unavailable`}
    </span>
  );
}
