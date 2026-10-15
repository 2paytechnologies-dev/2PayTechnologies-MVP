import type { Metadata, Viewport } from "next";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";
import { PwaRegister } from "@/components/PwaRegister";
import { ErrorReporter } from "@/components/ErrorReporter";
import { ApiBase } from "@/components/ApiBase";
import { APP_BG } from "@/lib/brand";

export const metadata: Metadata = {
  title: "2Pay Technologies — Payment Orchestration",
  description: "2-second non-custodial payment orchestration for Ethiopia",
  applicationName: "2Pay Merchant",
  // ?v= makes browsers fetch the new icons instead of the copy they cached; bump it whenever the icons change.
  icons: {
    icon: [
      { url: "/favicon.ico?v=3", sizes: "any" },
      { url: "/icons/icon-192.png?v=3", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png?v=3", sizes: "512x512", type: "image/png" },
    ],
    apple: "/icons/apple-touch-icon.png?v=3",
  },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: APP_BG };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <I18nProvider>
          <ApiBase />
          {children}
          <PwaRegister />
          <ErrorReporter />
        </I18nProvider>
      </body>
    </html>
  );
}
