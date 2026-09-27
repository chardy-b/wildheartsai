import type { Metadata, Viewport } from "next";
import { M_PLUS_Rounded_1c } from "next/font/google";
import { connection } from "next/server";
import { Analytics } from "./analytics";
import "./globals.css";

const rounded = M_PLUS_Rounded_1c({
  variable: "--font-rounded",
  weight: ["400", "500", "700", "800"],
  subsets: ["latin"],
  display: "swap",
});

const metadataBase = new URL(
  process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "http://localhost:3000"),
);

export const metadata: Metadata = {
  metadataBase,
  title: "Wild Hearts Health | Your care is scattered. Your story shouldn’t be.",
  description:
    "Gather your records from the health systems you choose into one clear timeline, and prepare for conversations with your care team.",
  openGraph: {
    title: "Wild Hearts Health",
    description: "A patient-controlled health record. Early access, by invitation.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#1b1619",
  colorScheme: "dark",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Render every page per request, so each gets the Content-Security-Policy nonce from src/proxy.ts.
  await connection();
  return (
    <html lang="en" className={rounded.variable}>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
