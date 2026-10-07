import Link from "next/link";
import { LayoutDashboard, Smartphone, Store, Zap } from "lucide-react";

const links = [
  { href: "/terminal", icon: Store, title: "Merchant Terminal", body: "Cashier screen — generate a dynamic pay node." },
  { href: "/dashboard", icon: LayoutDashboard, title: "Executive Dashboard", body: "Live GMV, velocity, fees and compliance view." },
];

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6 py-16">
      <div>
        <div className="mb-3 flex items-center gap-2 text-brand">
          <Zap className="h-6 w-6" />
          <span className="text-sm font-semibold uppercase tracking-widest">2Pay Technologies</span>
        </div>
        <h1 className="text-4xl font-bold">The 2-second payment orchestration layer</h1>
        <p className="mt-3 text-slate-400">
          Single-use dynamic tokens, cleared on EthioPay-IPS / Arifpay rails. 2Pay never touches funds.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {links.map(({ href, icon: Icon, title, body }) => (
          <Link key={href} href={href} className="rounded-2xl border border-slate-800 bg-slate-900 p-5 transition hover:border-brand">
            <Icon className="mb-3 h-6 w-6 text-brand" />
            <div className="font-semibold">{title}</div>
            <p className="mt-1 text-sm text-slate-400">{body}</p>
          </Link>
        ))}
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <Smartphone className="mb-3 h-6 w-6 text-brand" />
          <div className="font-semibold">Customer Screen</div>
          <p className="mt-1 text-sm text-slate-400">Opens from the terminal&apos;s QR / NFC link at /pay/[token].</p>
        </div>
      </div>
    </main>
  );
}
