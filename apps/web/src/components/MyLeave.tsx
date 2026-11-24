"use client";

import type { LeaveBalanceDto } from "@clbuddy/shared";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
const range = (a: string, b: string) => (a === b ? fmt(a) : `${fmt(a)} – ${fmt(b)}`);

/** Sidebar card: the signed-in person's own leave balance. */
export function MyLeave({ token, onAsk }: { token: string; onAsk: (q: string) => void }) {
  const [data, setData] = useState<LeaveBalanceDto | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api.leave.me(token).then(setData).catch(() => setData(null));
  }, [token]);

  if (!data) return null;
  const annual = data.balances.find((b) => b.leaveType === "ANNUAL");
  const others = data.balances.filter((b) => b.leaveType !== "ANNUAL");

  return (
    <div className="my-leave" data-testid="my-leave">
      <button type="button" className="my-leave-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span aria-hidden>🌴</span>
        {annual ? (
          <span>
            <strong>{annual.remaining}</strong> {annual.remaining === 1 ? "day" : "days"} of leave left
          </span>
        ) : (
          <span className="muted">Leave not set up yet</span>
        )}
        <span className="muted small">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="my-leave-body small">
          {annual ? (
            <>
              <dl className="leave-dl">
                <dt>Entitled ({data.year})</dt>
                <dd>{annual.entitled}</dd>
                {annual.carriedOver > 0 && (
                  <>
                    <dt>Carried over</dt>
                    <dd>{annual.carriedOver - annual.carryOverForfeited}</dd>
                  </>
                )}
                {annual.adjustments !== 0 && (
                  <>
                    <dt>Adjustments</dt>
                    <dd>{annual.adjustments}</dd>
                  </>
                )}
                <dt>Taken</dt>
                <dd>{annual.taken}</dd>
                <dt>Booked</dt>
                <dd>{annual.booked}</dd>
              </dl>
              {annual.carryOverToUseBeforeExpiry > 0 && annual.carryOverExpiresOn && (
                <p className="leave-warn">
                  ⏳ Use {annual.carryOverToUseBeforeExpiry} carried-over {annual.carryOverToUseBeforeExpiry === 1 ? "day" : "days"} by {fmt(annual.carryOverExpiresOn)}.
                </p>
              )}
              {others.map((b) => (
                <div key={b.leaveType} className="muted">
                  {b.leaveType.charAt(0) + b.leaveType.slice(1).toLowerCase()}: {b.total > 0 ? `${b.remaining} of ${b.total} left` : `${b.taken + b.booked} used`}
                </div>
              ))}
              {data.upcoming.length > 0 && (
                <div className="muted">Coming up: {data.upcoming.map((u) => range(u.startDate, u.endDate)).join(", ")}</div>
              )}
            </>
          ) : (
            <p className="muted">HR hasn&apos;t set up your {data.year} allowance yet.</p>
          )}
          <button type="button" className="link" onClick={() => onAsk("I'd like to plan some time off. How many leave days do I have?")}>
            Plan time off with CL Buddy →
          </button>
        </div>
      )}
    </div>
  );
}
