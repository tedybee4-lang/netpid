"use client";

import { useEffect, useState } from "react";

interface Reseller {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  commission_percentage: number;
  balance_minor: number;
  status: string;
}

export default function ResellersPage() {
  const [resellers, setResellers] = useState<Reseller[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    phone: "",
    email: "",
    commission_percentage: "10.0",
  });

  const loadData = () => {
    setLoading(true);
    fetch("/api/resellers")
      .then((r) => r.json())
      .then((d) => setResellers(d.resellers ?? []))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("/api/resellers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formData),
    });
    if (res.ok) {
      setShowAdd(false);
      setFormData({ name: "", phone: "", email: "", commission_percentage: "10.0" });
      loadData();
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Resellers & Field Agents</h1>
          <p className="text-sm text-muted-foreground">Manage agents selling vouchers and packages on commission.</p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="px-3 py-1.5 text-xs font-semibold rounded bg-primary text-primary-foreground"
        >
          {showAdd ? "Cancel" : "Add Reseller"}
        </button>
      </div>

      {showAdd && (
        <form onSubmit={handleCreate} className="p-4 border rounded bg-card space-y-4 max-w-xl">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Agent Name</label>
              <input
                required
                placeholder="e.g. John Mwangi"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="w-full text-sm border rounded p-1.5 bg-background"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Phone Number</label>
              <input
                required
                placeholder="07... or 254..."
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                className="w-full text-sm border rounded p-1.5 bg-background"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Email (Optional)</label>
              <input
                type="email"
                placeholder="agent@netpid.app"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                className="w-full text-sm border rounded p-1.5 bg-background"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Commission %</label>
              <input
                type="number"
                step="0.5"
                value={formData.commission_percentage}
                onChange={(e) => setFormData({ ...formData, commission_percentage: e.target.value })}
                className="w-full text-sm border rounded p-1.5 bg-background"
              />
            </div>
          </div>
          <button type="submit" className="px-4 py-1.5 text-xs font-semibold rounded bg-primary text-primary-foreground">
            Save Agent
          </button>
        </form>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading resellers...</p>
      ) : (
        <div className="card-flush overflow-x-auto">
          <table className="table min-w-[720px]">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3">Agent</th>
                <th className="p-3">Phone</th>
                <th className="p-3">Commission</th>
                <th className="p-3">Balance</th>
                <th className="p-3 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {resellers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-4 text-center text-muted-foreground">
                    No resellers registered yet.
                  </td>
                </tr>
              ) : (
                resellers.map((r) => (
                  <tr key={r.id}>
                    <td className="p-3 font-medium">{r.name}</td>
                    <td className="p-3 font-mono text-xs">{r.phone}</td>
                    <td className="p-3">{r.commission_percentage}%</td>
                    <td className="p-3 font-medium">KSh {(r.balance_minor / 100).toLocaleString()}</td>
                    <td className="p-3 text-right">
                      <span className="px-2 py-0.5 text-xs rounded capitalize font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-400">
                        {r.status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
