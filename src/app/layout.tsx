import type { Metadata, Viewport } from "next";
import { M_PLUS_Rounded_1c } from "next/font/google";
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
  title: "Wild Hearts Health | Every clinic, gathered into you",
  description:
    "A product in development to help patients gather records from the clinics they choose and prepare for conversations with their care team.",
  openGraph: {
    title: "Wild Hearts Health",
    description: "A patient-controlled health record concept in development.",
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
