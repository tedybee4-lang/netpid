"use client";

import { useEffect, useState } from "react";

interface InventoryItem {
  id: string;
  item_type: string;
  model: string;
  serial_number: string | null;
  mac_address: string | null;
  status: string;
  purchase_date: string | null;
}

export default function InventoryPage() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [formData, setFormData] = useState({
    item_type: "onu",
    model: "",
    serial_number: "",
    mac_address: "",
    status: "in_stock",
  });

  const loadData = () => {
    setLoading(true);
    fetch("/api/inventory")
      .then((r) => r.json())
      .then((d) => setItems(d.items ?? []))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("/api/inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formData),
    });
    if (res.ok) {
      setShowAdd(false);
      setFormData({ item_type: "onu", model: "", serial_number: "", mac_address: "", status: "in_stock" });
      loadData();
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Hardware & Inventory</h1>
          <p className="text-sm text-muted-foreground">Manage ONUs, CPE routers, and stock allocations.</p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="px-3 py-1.5 text-xs font-semibold rounded bg-primary text-primary-foreground"
        >
          {showAdd ? "Cancel" : "Add Hardware"}
        </button>
      </div>

      {showAdd && (
        <form onSubmit={handleCreate} className="p-4 border rounded bg-card space-y-4 max-w-xl">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Type</label>
              <select
                value={formData.item_type}
                onChange={(e) => setFormData({ ...formData, item_type: e.target.value })}
                className="w-full text-sm border rounded p-1.5 bg-background"
              >
                <option value="onu">ONU / ONT</option>
                <option value="router">Router / CPE</option>
                <option value="cable">Cable / Fiber</option>
                <option value="switch">Switch</option>
                <option value="accessory">Accessory</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Model</label>
              <input
                required
                placeholder="e.g. Huawei HG8310M"
                value={formData.model}
                onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                className="w-full text-sm border rounded p-1.5 bg-background"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Serial Number</label>
              <input
                placeholder="SN..."
                value={formData.serial_number}
                onChange={(e) => setFormData({ ...formData, serial_number: e.target.value })}
                className="w-full text-sm border rounded p-1.5 bg-background"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">MAC Address</label>
              <input
                placeholder="AA:BB:CC:..."
                value={formData.mac_address}
                onChange={(e) => setFormData({ ...formData, mac_address: e.target.value })}
                className="w-full text-sm border rounded p-1.5 bg-background"
              />
            </div>
          </div>
          <button type="submit" className="px-4 py-1.5 text-xs font-semibold rounded bg-primary text-primary-foreground">
            Save Item
          </button>
        </form>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading hardware records...</p>
      ) : (
        <div className="border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3">Type</th>
                <th className="p-3">Model</th>
                <th className="p-3">Serial / MAC</th>
                <th className="p-3">Status</th>
                <th className="p-3 text-right">Added</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-4 text-center text-muted-foreground">
                    No hardware tracked yet. Add devices to monitor stock.
                  </td>
                </tr>
              ) : (
                items.map((it) => (
                  <tr key={it.id}>
                    <td className="p-3 uppercase font-mono text-xs font-semibold">{it.item_type}</td>
                    <td className="p-3">{it.model}</td>
                    <td className="p-3 font-mono text-xs text-muted-foreground">
                      {it.serial_number || it.mac_address || "—"}
                    </td>
                    <td className="p-3">
                      <span className="px-2 py-0.5 text-xs rounded capitalize font-medium bg-muted">
                        {it.status.replace("_", " ")}
                      </span>
                    </td>
                    <td className="p-3 text-right text-xs text-muted-foreground">
                      {it.purchase_date || "—"}
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
