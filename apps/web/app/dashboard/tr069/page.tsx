"use client";

import { useEffect, useState } from "react";

interface Device {
  id: string;
  serial_number: string;
  manufacturer: string;
  product_class: string;
  status: string;
  last_inform_at: string | null;
  ip_address: string | null;
}

export default function Tr069Page() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = () => {
    setLoading(true);
    fetch("/api/tr069")
      .then((r) => r.json())
      .then((d) => setDevices(d.devices ?? []))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, []);

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">TR-069 ACS Device Management</h1>
          <p className="text-sm text-muted-foreground">Auto-configuration, optical power telemetry, and remote reboot for customer ONUs and CPEs.</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="p-4 border rounded bg-card">
          <p className="text-xs uppercase text-muted-foreground font-semibold">Managed ONUs / CPEs</p>
          <p className="text-2xl font-bold mt-1">{devices.length}</p>
        </div>
        <div className="p-4 border rounded bg-card">
          <p className="text-xs uppercase text-muted-foreground font-semibold">Online via TR-069</p>
          <p className="text-2xl font-bold mt-1 text-emerald-600">
            {devices.filter((d) => d.status === "online").length}
          </p>
        </div>
        <div className="p-4 border rounded bg-card">
          <p className="text-xs uppercase text-muted-foreground font-semibold">ACS Status</p>
          <p className="text-sm font-semibold mt-2 text-primary">TR-069 ACS Active</p>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading TR-069 CPE telemetry...</p>
      ) : (
        <div className="card-flush overflow-x-auto">
          <table className="table min-w-[720px]">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3">Serial Number</th>
                <th className="p-3">Model / Vendor</th>
                <th className="p-3">IP Address</th>
                <th className="p-3">Last Inform</th>
                <th className="p-3 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {devices.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-4 text-center text-muted-foreground">
                    No TR-069 devices provisioned yet. Set your CPE ACS URL to point to NETPID ACS.
                  </td>
                </tr>
              ) : (
                devices.map((d) => (
                  <tr key={d.id}>
                    <td className="p-3 font-mono text-xs font-semibold">{d.serial_number}</td>
                    <td className="p-3">{d.manufacturer} {d.product_class}</td>
                    <td className="p-3 font-mono text-xs">{d.ip_address || "—"}</td>
                    <td className="p-3 text-xs text-muted-foreground">
                      {d.last_inform_at ? new Date(d.last_inform_at).toLocaleString() : "Never"}
                    </td>
                    <td className="p-3 text-right">
                      <span className="px-2 py-0.5 text-xs rounded capitalize font-medium bg-muted">
                        {d.status}
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
