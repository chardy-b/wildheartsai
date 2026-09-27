import type { Metadata, Viewport } from "next";
import { M_PLUS_Rounded_1c } from "next/font/google";
import "./globals.css";

const rounded = M_PLUS_Rounded_1c({
  variable: "--font-rounded",
  weight: ["400", "500", "700", "800"],
  subsets: ["latin"],
  display: "swap",
});

// Inlined at build time: set NEXT_PUBLIC_SITE_URL in the build environment (see README).
const metadataBase = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000");

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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={rounded.variable}>
      <body>{children}</body>
    </html>
  );
}
