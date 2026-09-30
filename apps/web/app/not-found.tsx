import Link from "next/link";

// App-wide 404. Without this file Next.js renders its own bare default page,
// which drops the NETPID shell entirely — a visitor who mistypes a URL lands on
// a page that looks like a different product.
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-16">
      <div className="card w-full max-w-md text-center">
        <p className="text-xs font-bold uppercase tracking-widest text-indigo-600">Error 404</p>
        <h1 className="mt-2 text-2xl font-black tracking-tight">That page isn&apos;t here</h1>
        <p className="mt-2 text-sm text-slate-600">
          The link may be out of date, or the record it pointed at has been removed.
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Link href="/dashboard" className="btn-primary">Go to dashboard</Link>
          <Link href="/" className="btn-ghost">Back to NETPID</Link>
        </div>
      </div>
    </main>
  );
}