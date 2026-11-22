import type { Metadata, Viewport } from "next";
import { HoloDemo } from "@/components/landing/demo/HoloDemo";

export const metadata: Metadata = {
  title: "Holo Demo | Wild Hearts Health",
  description: "Explore a sample conversation with Holo from Wild Hearts Health.",
};

export const viewport: Viewport = { themeColor: "#1b1619", colorScheme: "light" };

export default function DemoPage() {
  return <HoloDemo />;
}