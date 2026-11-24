"use client";

import { CLASSIFICATIONS, type AuditEventDto, type Classification, type GroupDto } from "@localmind/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type AdminUserDto } from "@/lib/api";
import { CLASSIFICATION_LABELS, relativeTime } from "@/lib/format";

type Tab = "people" | "groups" | "audit";

/** Organisation settings: people (role, clearance, groups), groups, and the audit log. */
export function AdminPanel({ token, currentUserId, onClose }: { token: string; currentUserId: string; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("people");
  const [users, setUsers] = useState<AdminUserDto[]>([]);
  const [groups, setGroups] = useState<GroupDto[]>([]);
  const [audit, setAudit] = useState<AuditEventDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newGroup, setNewGroup] = useState("");
  const [person, setPerson] = useState({ email: "", password: "" });

  const load = useCallback(async () => {
    try {
      const [u, g, a] = await Promise.all([api.admin.users(token), api.admin.groups(token), api.admin.audit(token)]);
      setUsers(u);
      setGroups(g);
      setAudit(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Request failed");
    }
  }

  const toggleGroup = (u: AdminUserDto, groupId: string) => {
    const ids = u.groups.map((g) => g.id);
    const next = ids.includes(groupId) ? ids.filter((g) => g !== groupId) : [...ids, groupId];
    return run(() => api.admin.updateUser(token, u.id, { groupIds: next }));
  };

  async function addGroup(e: FormEvent) {
    e.preventDefault();
    if (!newGroup.trim()) return;
    await run(() => api.admin.createGroup(token, newGroup.trim()));
    setNewGroup("");
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Organization settings" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <header className="panel-head">
          <h2>Organization</h2>
          <div className="tabs compact" role="tablist">
            {(["people", "groups", "audit"] as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)} type="button">
                {t === "people" ? "People" : t === "groups" ? "Groups" : "Audit log"}
              </button>
            ))}
          </div>
          <button type="button" className="icon-btn visible" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {tab === "people" && (
          <div className="table-wrap">
            <form
              className="inline-form"
              onSubmit={async (e) => {
                e.preventDefault();
                await run(() => api.admin.createUser(token, person));
                setPerson({ email: "", password: "" });
              }}
            >
              <input aria-label="New person's email" type="email" required placeholder="new.person@company.com" value={person.email} onChange={(e) => setPerson({ ...person, email: e.target.value })} />
              <input aria-label="Temporary password" type="password" required minLength={12} placeholder="Temporary password (12+ chars)" value={person.password} onChange={(e) => setPerson({ ...person, password: e.target.value })} />
              <button className="btn-primary btn-sm" type="submit">
                Add person
              </button>
            </form>
            <p className="hint">
              Clearance is the most sensitive classification a person can read in documents shared with them. Group membership controls
              which group-shared documents they can see. Changes apply on their next request.
            </p>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Clearance</th>
                  <th>Groups</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="ellipsis" title={u.email}>
                      {u.email}
                      {u.id === currentUserId && <span className="muted"> (you)</span>}
                    </td>
                    <td>
                      <select
                        aria-label={`Role for ${u.email}`}
                        value={u.role}
                        onChange={(e) => void run(() => api.admin.updateUser(token, u.id, { role: e.target.value as "USER" | "ADMIN" }))}
                      >
                        <option value="USER">Member</option>
                        <option value="ADMIN">Admin</option>
                      </select>
                    </td>
                    <td>
                      <select
                        aria-label={`Clearance for ${u.email}`}
                        value={u.clearance}
                        onChange={(e) => void run(() => api.admin.updateUser(token, u.id, { clearance: e.target.value as Classification }))}
                      >
                        {CLASSIFICATIONS.map((c) => (
                          <option key={c} value={c}>
                            {CLASSIFICATION_LABELS[c]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <div className="chips">
                        {groups.map((g) => {
                          const on = u.groups.some((x) => x.id === g.id);
                          return (
                            <button
                              key={g.id}
                              type="button"
                              className={`chip ${on ? "on" : ""}`}
                              aria-pressed={on}
                              onClick={() => void toggleGroup(u, g.id)}
                            >
                              {g.name}
                            </button>
                          );
                        })}
                        {groups.length === 0 && <span className="muted small">Create a group first</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "groups" && (
          <div>
            <form className="inline-form" onSubmit={addGroup}>
              <input aria-label="New group name" placeholder="New group, e.g. HR" value={newGroup} maxLength={60} onChange={(e) => setNewGroup(e.target.value)} />
              <button className="btn-primary btn-sm" type="submit" disabled={!newGroup.trim()}>
                Add group
              </button>
            </form>
            <ul className="group-list">
              {groups.map((g) => (
                <li key={g.id}>
                  <div>
                    <strong>{g.name}</strong>
                    <div className="muted small">
                      {g.memberCount} member{g.memberCount === 1 ? "" : "s"} · {g.documentCount} document{g.documentCount === 1 ? "" : "s"}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="link danger"
                    onClick={() =>
                      confirm(`Delete group “${g.name}”? Documents shared only with it will no longer be visible to its members.`) &&
                      void run(() => api.admin.deleteGroup(token, g.id))
                    }
                  >
                    Delete
                  </button>
                </li>
              ))}
              {groups.length === 0 && <li className="muted small">No groups yet.</li>}
            </ul>
          </div>
        )}

        {tab === "audit" && (
          <ul className="audit-list">
            {audit.map((e) => (
              <li key={e.id}>
                <code>{e.action}</code>
                <span className="muted small">
                  {e.actorEmail ?? "system"} · {relativeTime(e.createdAt)}
                </span>
                <span className="small audit-detail">{summarize(e)}</span>
              </li>
            ))}
            {audit.length === 0 && <li className="muted small">No events yet.</li>}
          </ul>
        )}
      </div>
    </div>
  );
}

function summarize(e: AuditEventDto): string {
  const d = (e.details ?? {}) as Record<string, any>;
  if (d.filename && d.after) return `${d.filename}: ${d.before?.visibility}/${d.before?.classification} → ${d.after.visibility}/${d.after.classification}`;
  if (d.filename) return `${d.filename}${d.visibility ? ` → ${d.visibility}/${d.classification}` : ""}`;
  if (d.email) return `${d.email}: ${JSON.stringify(d.after)}`;
  if (d.name) return d.name;
  return "";
}
