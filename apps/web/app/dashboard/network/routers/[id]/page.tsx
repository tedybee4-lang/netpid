"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type Job = { id: string; kind: string; status: string; last_error: string | null };

export default function RouterDetail() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [username, setUsername] = useState("");

  async function poll(jobId: string) {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const j = await fetch(`/api/network/jobs?job=${jobId}`).then((r) => r.json());
      setJob(j.job);
      if (["completed", "failed", "cancelled"].includes(j.job.status)) break;
    }
  }

  async function action(a: string) {
    setMsg("Queued…");
    const res = await fetch(`/api/routers/${id}/test`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: a, username: username || undefined }),
    });
    const j = await res.json();
    if (!res.ok) { setMsg(j.error ?? "Failed"); return; }
    setMsg("Running — polling job status…");
    poll(j.job_id);
  }

  useEffect(() => {
    fetch(`/api/routers/${id}/test`).then((r) => r.json()).then(() => {});
  }, [id]);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <a className="text-sm text-indigo-600 hover:underline" href="/dashboard/network">← Network</a>
      <h1 className="mt-2 text-2xl font-black">Router</h1>
      <div className="card mt-4 space-y-2">
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" onClick={() => action("test")}>Test connection</button>
          <button className="btn-ghost" onClick={() => action("backup")}>Backup now</button>
        </div>
        <div className="flex gap-2">
          <input className="input" placeholder="username to disconnect" value={username} onChange={(e) => setUsername(e.target.value)} />
          <button className="btn-ghost" onClick={() => action("disconnect")}>Disconnect user</button>
        </div>
        {msg && <p className="text-sm text-slate-600">{msg}</p>}
        {job && <p className="rounded-xl bg-slate-100 p-3 text-sm"><b>{job.kind}</b>: {job.status}{job.last_error ? ` — ${job.last_error}` : ""}</p>}
      </div>
    </main>
  );
}
