"use client";

import { useEffect, useState } from "react";

interface Node {
  id: string;
  name: string;
  node_type: string;
  address: string | null;
  status: string;
  routers: { name: string; host: string } | null;
}

export default function TopologyPage() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    node_type: "tower",
    address: "",
  });

  const loadData = () => {
    setLoading(true);
    fetch("/api/topology")
      .then((r) => r.json())
      .then((d) => setNodes(d.nodes ?? []))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("/api/topology", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formData),
    });
    if (res.ok) {
      setShowAdd(false);
      setFormData({ name: "", node_type: "tower", address: "" });
      loadData();
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Network Topology & Distribution</h1>
          <p className="text-sm text-muted-foreground">Map core PoPs, base stations, transmission towers, and fiber splitters.</p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="px-3 py-1.5 text-xs font-semibold rounded bg-primary text-primary-foreground"
        >
          {showAdd ? "Cancel" : "Add Node"}
        </button>
      </div>

      {showAdd && (
        <form onSubmit={handleCreate} className="p-4 border rounded bg-card space-y-4 max-w-xl">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Node Name</label>
              <input
                required
                placeholder="e.g. Westlands PoP Tower 1"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="w-full text-sm border rounded p-1.5 bg-background"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Type</label>
              <select
                value={formData.node_type}
                onChange={(e) => setFormData({ ...formData, node_type: e.target.value })}
                className="w-full text-sm border rounded p-1.5 bg-background"
              >
                <option value="core_pop">Core PoP / Data Center</option>
                <option value="tower">Transmission Tower / Mast</option>
                <option value="olt">OLT Fiber Termination</option>
                <option value="splitter_box">Fiber Splitter / FAT Box</option>
                <option value="switch">Distribution Switch</option>
                <option value="ap">Access Point / Sector</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Location / Address</label>
            <input
              placeholder="e.g. Chiromo Road, Westlands"
              value={formData.address}
              onChange={(e) => setFormData({ ...formData, address: e.target.value })}
              className="w-full text-sm border rounded p-1.5 bg-background"
            />
          </div>
          <button type="submit" className="px-4 py-1.5 text-xs font-semibold rounded bg-primary text-primary-foreground">
            Save Node
          </button>
        </form>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading network topology...</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {nodes.length === 0 ? (
            <div className="col-span-full border border-dashed rounded p-8 text-center text-muted-foreground">
              No topology nodes configured. Map your towers and fiber distribution points here.
            </div>
          ) : (
            nodes.map((n) => (
              <div key={n.id} className="p-4 border rounded bg-card space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm">{n.name}</span>
                  <span className="px-2 py-0.5 text-xs rounded uppercase font-mono bg-muted font-bold">
                    {n.node_type.replace("_", " ")}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{n.address || "No address recorded"}</p>
                <div className="pt-2 border-t flex items-center justify-between text-xs">
                  <span className="text-emerald-600 font-medium">● {n.status}</span>
                  {n.routers && <span className="font-mono text-muted-foreground">{n.routers.name}</span>}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
