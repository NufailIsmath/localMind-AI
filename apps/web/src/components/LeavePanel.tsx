"use client";

import type { LeavePersonSummaryDto, LeaveType } from "@clbuddy/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";

const TYPES: LeaveType[] = ["ANNUAL", "SICK", "PARENTAL", "UNPAID", "OTHER"];
const label = (t: string) => t.charAt(0) + t.slice(1).toLowerCase();

/** HR/admin: everyone's leave — allowances, entries, holidays, CSV import. */
export function LeavePanel({ token, onClose }: { token: string; onClose: () => void }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [people, setPeople] = useState<LeavePersonSummaryDto[]>([]);
  const [holidays, setHolidays] = useState<{ date: string; name: string }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<"people" | "holidays" | "import">("people");

  const load = useCallback(async () => {
    try {
      const [p, h] = await Promise.all([api.leave.people(token, year), api.leave.holidays(token, year)]);
      setPeople(p);
      setHolidays(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [token, year]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
      await load();
    } catch (e) {
      if (e instanceof ApiError && Array.isArray(e.details)) {
        setError(`${e.message}: ${(e.details as { row?: number; message: string; path?: string }[]).map((d) => (d.row ? `row ${d.row}: ${d.message}` : d.message)).join("; ")}`);
      } else setError(e instanceof Error ? e.message : "Request failed");
    }
  }

  const person = people.find((p) => p.userId === selected) ?? null;

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Manage leave" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <header className="panel-head">
          <h2>Leave</h2>
          <div className="tabs compact" role="tablist">
            {(["people", "holidays", "import"] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)} type="button">
                {t === "people" ? "People" : t === "holidays" ? "Holidays" : "Import"}
              </button>
            ))}
          </div>
          <label className="small year-pick">
            Year{" "}
            <input type="number" aria-label="Year" min={2000} max={2100} value={year} onChange={(e) => setYear(Number(e.target.value) || year)} />
          </label>
          <button type="button" className="icon-btn visible" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="notice small">{notice}</p>}

        {tab === "people" && (
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Entitled</th>
                  <th>Carried</th>
                  <th>Taken</th>
                  <th>Booked</th>
                  <th>Left</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.userId} className={p.userId === selected ? "row-selected" : ""}>
                    <td className="ellipsis" title={p.email}>
                      {p.email}
                    </td>
                    {p.annual ? (
                      <>
                        <td>{p.annual.entitled}</td>
                        <td>
                          {p.annual.carriedOver}
                          {p.annual.carryOverForfeited > 0 && <span className="muted"> (−{p.annual.carryOverForfeited})</span>}
                        </td>
                        <td>{p.annual.taken}</td>
                        <td>{p.annual.booked}</td>
                        <td>
                          <strong>{p.annual.remaining}</strong>
                        </td>
                      </>
                    ) : (
                      <td colSpan={5} className="muted">
                        Not set up
                      </td>
                    )}
                    <td>
                      <button type="button" className="link" onClick={() => setSelected(p.userId === selected ? null : p.userId)}>
                        {p.userId === selected ? "Close" : "Edit"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {person && <PersonEditor key={person.userId + year} person={person} year={year} token={token} run={run} />}
          </div>
        )}

        {tab === "holidays" && <Holidays holidays={holidays} token={token} run={run} />}
        {tab === "import" && <ImportCsv token={token} run={run} />}
      </div>
    </div>
  );
}

type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;

function PersonEditor({ person, year, token, run }: { person: LeavePersonSummaryDto; year: number; token: string; run: Run }) {
  const a = person.allowances.find((x) => x.leaveType === "ANNUAL");
  const [allow, setAllow] = useState({
    entitledDays: String(a?.entitledDays ?? 21),
    carriedOverDays: String(a?.carriedOverDays ?? 0),
    carryOverExpiresOn: a?.carryOverExpiresOn ?? "",
    adjustmentDays: String(a?.adjustmentDays ?? 0),
  });
  const [entry, setEntry] = useState({ leaveType: "ANNUAL" as LeaveType, startDate: "", endDate: "", days: "", note: "" });

  function saveAllowance(e: FormEvent) {
    e.preventDefault();
    void run(
      () =>
        api.leave.setAllowance(token, {
          userId: person.userId,
          year,
          leaveType: "ANNUAL",
          entitledDays: Number(allow.entitledDays),
          carriedOverDays: Number(allow.carriedOverDays || 0),
          carryOverExpiresOn: allow.carryOverExpiresOn || null,
          adjustmentDays: Number(allow.adjustmentDays || 0),
        }),
      `Saved ${person.email}'s ${year} allowance`,
    );
  }

  function addEntry(e: FormEvent) {
    e.preventDefault();
    void run(
      () =>
        api.leave.addEntry(token, {
          userId: person.userId,
          leaveType: entry.leaveType,
          startDate: entry.startDate,
          endDate: entry.endDate || entry.startDate,
          ...(entry.days ? { days: Number(entry.days) } : {}),
          ...(entry.note ? { note: entry.note } : {}),
        }),
      "Leave recorded",
    ).then(() => setEntry({ ...entry, startDate: "", endDate: "", days: "", note: "" }));
  }

  return (
    <div className="person-editor" data-testid="leave-editor">
      <h3 className="small">{person.email}</h3>
      <form className="leave-form" onSubmit={saveAllowance}>
        <strong className="small">Annual allowance {year}</strong>
        <label>
          Entitled days
          <input type="number" step="0.5" min="0" required value={allow.entitledDays} onChange={(e) => setAllow({ ...allow, entitledDays: e.target.value })} />
        </label>
        <label>
          Carried over
          <input type="number" step="0.5" min="0" value={allow.carriedOverDays} onChange={(e) => setAllow({ ...allow, carriedOverDays: e.target.value })} />
        </label>
        <label>
          Carry-over expires
          <input type="date" value={allow.carryOverExpiresOn} onChange={(e) => setAllow({ ...allow, carryOverExpiresOn: e.target.value })} />
        </label>
        <label>
          Adjustment (±)
          <input type="number" step="0.5" value={allow.adjustmentDays} onChange={(e) => setAllow({ ...allow, adjustmentDays: e.target.value })} />
        </label>
        <button className="btn-primary btn-sm" type="submit">
          Save allowance
        </button>
      </form>

      <form className="leave-form" onSubmit={addEntry}>
        <strong className="small">Record leave</strong>
        <label>
          Type
          <select value={entry.leaveType} onChange={(e) => setEntry({ ...entry, leaveType: e.target.value as LeaveType })}>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {label(t)}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input type="date" required value={entry.startDate} onChange={(e) => setEntry({ ...entry, startDate: e.target.value })} />
        </label>
        <label>
          To
          <input type="date" value={entry.endDate} onChange={(e) => setEntry({ ...entry, endDate: e.target.value })} />
        </label>
        <label>
          Days (optional)
          <input type="number" step="0.5" min="0.5" placeholder="auto" value={entry.days} onChange={(e) => setEntry({ ...entry, days: e.target.value })} />
        </label>
        <label>
          Note
          <input maxLength={200} value={entry.note} onChange={(e) => setEntry({ ...entry, note: e.target.value })} />
        </label>
        <button className="btn-primary btn-sm" type="submit">
          Add
        </button>
      </form>

      <ul className="entry-list small">
        {person.entries.map((e) => (
          <li key={e.id} className={e.status === "CANCELLED" ? "cancelled" : ""}>
            <span>
              {label(e.leaveType)} · {e.startDate === e.endDate ? e.startDate : `${e.startDate} → ${e.endDate}`} · {e.days} {e.days === 1 ? "day" : "days"}
              {e.note && <span className="muted"> · {e.note}</span>}
              {e.status === "CANCELLED" && <span className="muted"> · cancelled</span>}
            </span>
            {e.status === "APPROVED" && (
              <button type="button" className="link danger" onClick={() => void run(() => api.leave.cancelEntry(token, e.id), "Leave cancelled")}>
                Cancel
              </button>
            )}
          </li>
        ))}
        {person.entries.length === 0 && <li className="muted">No leave recorded for {year}.</li>}
      </ul>
    </div>
  );
}

function Holidays({ holidays, token, run }: { holidays: { date: string; name: string }[]; token: string; run: Run }) {
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  return (
    <div>
      <p className="hint">Company holidays aren&apos;t counted as leave days.</p>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => api.leave.addHoliday(token, date, name), "Holiday added").then(() => {
            setDate("");
            setName("");
          });
        }}
      >
        <input type="date" aria-label="Holiday date" required value={date} onChange={(e) => setDate(e.target.value)} />
        <input aria-label="Holiday name" placeholder="e.g. New Year's Day" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn-primary btn-sm" type="submit">
          Add holiday
        </button>
      </form>
      <ul className="group-list">
        {holidays.map((h) => (
          <li key={h.date}>
            <span>
              <strong>{h.date}</strong> {h.name}
            </span>
            <button type="button" className="link danger" onClick={() => void run(() => api.leave.removeHoliday(token, h.date), "Holiday removed")}>
              Remove
            </button>
          </li>
        ))}
        {holidays.length === 0 && <li className="muted small">No holidays for this year.</li>}
      </ul>
    </div>
  );
}

function ImportCsv({ token, run }: { token: string; run: Run }) {
  const [kind, setKind] = useState<"allowances" | "entries">("allowances");
  const [csv, setCsv] = useState("");
  const example =
    kind === "allowances"
      ? "email,year,leave_type,entitled_days,carried_over_days,carry_over_expires,adjustment_days,note\nsam@company.com,2026,ANNUAL,21,3,2026-03-31,0,"
      : "email,leave_type,start_date,end_date,days,note\nsam@company.com,ANNUAL,2026-03-02,2026-03-06,,Family trip";
  return (
    <div className="import">
      <p className="hint">
        Paste a CSV exported from your spreadsheet (or choose a file). Every row is checked first; if anything is wrong, nothing is imported and
        you&apos;ll see which rows to fix.
      </p>
      <div className="inline-form">
        <select aria-label="What to import" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="allowances">Allowances</option>
          <option value="entries">Leave taken / booked</option>
        </select>
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="CSV file"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setCsv(await f.text());
          }}
        />
      </div>
      <textarea aria-label="CSV" rows={8} placeholder={example} value={csv} onChange={(e) => setCsv(e.target.value)} />
      <div className="doc-actions">
        <button className="btn-primary btn-sm" type="button" disabled={!csv.trim()} onClick={() =>
            void run(async () => {
              const r = await api.leave.importCsv(token, kind, csv);
              setCsv("");
              return r;
            }, "Imported")
          }>
          Import
        </button>
        <button type="button" className="link" onClick={() => setCsv(example)}>
          Use example
        </button>
      </div>
    </div>
  );
}
