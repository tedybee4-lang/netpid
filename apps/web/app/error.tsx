"use client";

// App-wide error boundary. Without it a thrown server error blanks the page to
// a bare "Application error" — the user sees a broken screen and no way forward.
//
// SECURITY: the operator-facing copy never includes the underlying message. A
// Postgres error can carry SQL fragments, column names and row counts; the raw
// detail is rendered ONLY in development, and Next.js compiles NODE_ENV into the
// client bundle, so a production build ships the friendly text alone.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const isDev = process.env.NODE_ENV === "development";

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-16">
      <div className="card w-full max-w-md">
        <p className="text-xs font-bold uppercase tracking-widest text-red-600">Something went wrong</p>
        <h1 className="mt-2 text-2xl font-black tracking-tight">This screen could not load</h1>
        <p className="mt-2 text-sm text-slate-600">
          The problem has been recorded. Trying again often clears it — if it keeps happening,
          check the platform status page or contact support.
        </p>

        {isDev && (
          <pre className="code-block mt-4 whitespace-pre-wrap text-red-300">
            {error.message}
            {error.digest ? `\n\ndigest: ${error.digest}` : ""}
          </pre>
        )}

        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button type="button" className="btn-primary" onClick={reset}>Try again</button>
          <a href="/dashboard" className="btn-ghost">Go to dashboard</a>
        </div>
      </div>
    </main>
  );
}