"use client";
import PageShell, { Empty } from "@/components/PageShell";
import IntegrationCard, { useIntegrations } from "@/components/IntegrationCard";

// UISP is the one integration with a real purpose in an ISP deployment: it lets
// an operator who already run UISP keep it as the source of truth while NETPID
// handles billing and provisioning.
export default function UispPage() {
  const { rows, loading, reload } = useIntegrations();
  const uisp = rows.find((r) => r.provider === "uisp") ?? null;

  return (
    <PageShell
      title="UISP integration"
      description="Connect a UISP instance so existing subscribers and plans can be imported, and so NETPID stops duplicating data you already maintain."
    >
      {loading ? <Empty>Loading…</Empty> : (
        <>
          <IntegrationCard key={uisp?.id ?? "new"} provider="uisp" initial={uisp} />

          <div className="card mt-4">
            <p className="panel-title mb-3">What happens when this is enabled</p>
            <ul className="ml-4 list-disc space-y-1.5 text-sm text-slate-600">
              <li>UISP stays authoritative for subscriber records; NETPID does not overwrite them.</li>
              <li>UISP plans are mapped to NETPID packages when you import, keeping the speed caps intact.</li>
              <li>Devices already pushed by UISP are left alone — NETPID only manages what it added itself.</li>
              <li>Imported customers keep their UISP IDs, so a later re-import updates rather than duplicates.</li>
            </ul>
          </div>

          <div className="card mt-4">
            <p className="font-semibold">Need the key?</p>
            <p className="mt-1 text-sm text-slate-600">
              In UISP open <strong>Users → Admin → API</strong>, create a token, then paste the base URL of your
              UISP server (usually <code className="rounded bg-slate-100 px-1">https://uisp.example.com</code>)
              together with the token above.
            </p>
            <button className="btn-ghost btn-sm mt-3" onClick={reload}>Reload status</button>
          </div>
        </>
      )}
    </PageShell>
  );
}
