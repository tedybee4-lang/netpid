import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NETPID — Complete ISP Management Platform",
  description: "Manage. Connect. Bill. Multi-tenant ISP management & billing.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
