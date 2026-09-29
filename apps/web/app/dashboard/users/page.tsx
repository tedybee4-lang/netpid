"use client";

import { useCallback, useEffect, useState } from "react";

interface Role { slug: string; name: string }
interface Member {
  id: string;
  user_id: string;
  email: string | null;
  full_name: string | null;
  phone: string | null;
  is_active: boolean;
  created_at: string;
  roles: Role[];
}
interface RoleInfo { slug: string; name: string; description: string | null }

export default function UsersPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [staffLimit, setStaffLimit] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [saving, setSaving] = useState(false);
  const [invite, setInvite] = useState({ email: "", full_name: "", role: "technician" });

  const load = useCallback(() => {
    fetch("/api/users")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Failed to load team");
        setMembers(j.members ?? []);
        setRoles(j.roles ?? []);
        setMe(j.me ?? null);
        setStaffLimit(j.staff_limit ?? null);
        setErr(null);
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "Failed to load team"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setNotice(null); setSaving(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invite),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Invite failed");
      setNotice(j.message ?? "Member added.");
      setInvite({ email: "", full_name: "", role: "technician" });
      setShowInvite(false);
      load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Invite failed");
    } finally {
      setSaving(false);
    }
  }

  async function patchMember(id: string, body: Record<string, unknown>) {
    setErr(null); setNotice(null);
    const res = await fetch("/api/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
    const j = await res.json();
    if (!res.ok) { setErr(j.error ?? "Update failed"); return; }
    load();
  }

  async function removeMember(m: Member) {
    const who = m.full_name ?? m.email ?? "this member";
    if (!window.confirm(`Remove ${who} from this ISP? Their login stays active but loses access here.`)) return;
    setErr(null); setNotice(null);
    const res = await fetch(`/api/users?id=${encodeURIComponent(m.id)}`, { method: "DELETE" });
    const j = await res.json();
    if (!res.ok) { setErr(j.error ?? "Remove failed"); return; }
    setNotice(`${who} removed.`);
    load();
  }

  const atCap = staffLimit !== null && members.length >= staffLimit;

  return (
    <main className="mx-auto max-w-[1200px] px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Users &amp; roles</h1>
          <p className="mt-1 text-sm text-slate-500">
            Staff who can sign in to this ISP console.
            {staffLimit !== null && ` ${members.length} of ${staffLimit} seats used.`}
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowInvite((v) => !v)}
          disabled={atCap && !showInvite}>
          {showInvite ? "Cancel" : atCap ? "Seat limit reached" : "Invite member"}
        </button>
      </header>

      {err && <p className="err-box mt-4">{err}</p>}
      {notice && <p className="ok-box mt-4">{notice}</p>}

      {showInvite && (
        <form onSubmit={handleInvite} className="card mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="invite-email">Email</label>
            <input id="invite-email" className="input" type="email" required
              placeholder="staff@yourisp.co.ke"
              value={invite.email}
              onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="invite-name">Full name</label>
            <input id="invite-name" className="input" placeholder="Jane Wanjiku"
              value={invite.full_name}
              onChange={(e) => setInvite({ ...invite, full_name: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="invite-role">Role</label>
            <select id="invite-role" className="input" value={invite.role}
              onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
              {roles.filter((r) => r.slug !== "owner").map((r) => (
                <option key={r.slug} value={r.slug}>{r.name}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <button className="btn-primary w-full" disabled={saving}>
              {saving ? "Inviting…" : "Send invite"}
            </button>
          </div>
          <p className="hint sm:col-span-2">
            New accounts get an email with a set-password link. Existing NETPID accounts
            are added directly without an email.
          </p>
        </form>
      )}

      <div className="card-flush mt-4 overflow-x-auto">
        <table className="table min-w-[720px]">
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th>Status</th>
              <th>Joined</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="!py-8 text-center text-slate-400">Loading team…</td></tr>
            ) : members.length === 0 ? (
              <tr><td colSpan={5} className="!py-8 text-center text-slate-400">
                No staff yet. Invite your first team member.
              </td></tr>
            ) : members.map((m) => {
              const isOwner = m.roles.some((r) => r.slug === "owner");
              const isSelf = m.user_id === me;
              // Own access and the owner's access are protected server-side too;
              // disable the controls here so the UI never promises otherwise.
              const locked = isOwner || isSelf;
              return (
                <tr key={m.id}>
                  <td>
                    <p className="font-semibold text-slate-900">
                      {m.full_name ?? "—"}
                      {isSelf && <span className="badge badge-info ml-2">you</span>}
                    </p>
                    <p className="text-xs text-slate-500">{m.email ?? "—"}</p>
                  </td>
                  <td>
                    {isOwner ? (
                      <span className="badge badge-info">Owner</span>
                    ) : (
                    <select
                      className="input !w-auto !py-1 text-xs"
                      value={m.roles[0]?.slug ?? ""}
                      disabled={locked || saving}
                      title={isSelf ? "Ask another admin to change your role" : "Change role"}
                      onChange={(e) => patchMember(m.id, { role: e.target.value })}
                    >
                      {m.roles.length === 0 && <option value="">No role</option>}
                      {roles.filter((r) => r.slug !== "owner").map((r) => (
                        <option key={r.slug} value={r.slug}>{r.name}</option>
                      ))}
                    </select>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${m.is_active ? "badge-ok" : "badge-bad"}`}>
                      {m.is_active ? "Active" : "Disabled"}
                    </span>
                  </td>
                  <td className="text-slate-500">
                    {new Date(m.created_at).toLocaleDateString()}
                  </td>
                  <td>
                    <div className="flex justify-end gap-2">
                      <button
                        className={m.is_active ? "btn-ghost btn-sm" : "btn-primary btn-sm"}
                        disabled={locked || saving}
                        onClick={() => patchMember(m.id, { is_active: !m.is_active })}
                      >
                        {m.is_active ? "Disable" : "Enable"}
                      </button>
                      <button
                        className="btn-danger btn-sm"
                        disabled={locked || saving}
                        onClick={() => removeMember(m)}
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="hint mt-3">
        Roles map to RLS permissions: admins manage everything, technicians get routers
        and network, cashiers get payments, support gets customers. The owner role is
        fixed at ISP creation.
      </p>
    </main>
  );
}
