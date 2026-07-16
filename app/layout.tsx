import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TripTrace Research — Travel-video evidence",
  description: "Research a place from multiple YouTube travel videos, timed captions, and source-linked frames."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
