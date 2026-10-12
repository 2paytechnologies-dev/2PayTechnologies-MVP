import type { Metadata, Viewport } from "next";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";
import { PwaRegister } from "@/components/PwaRegister";
import { ErrorReporter } from "@/components/ErrorReporter";
import { APP_BG } from "@/lib/brand";

export const metadata: Metadata = {
  title: "2Pay Technologies — Payment Orchestration",
  description: "2-second non-custodial payment orchestration for Ethiopia",
  applicationName: "2Pay Merchant",
  icons: { icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }, { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }], apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: APP_BG };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <I18nProvider>
          {children}
          <PwaRegister />
          <ErrorReporter />
        </I18nProvider>
      </body>
    </html>
  );
}
