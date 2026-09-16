import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Cinzel } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// display face for titles/headers/buttons — the narration log and form
// inputs stay in Geist (mono/sans) since a fantasy face at reading size
// hurts legibility fast
const cinzel = Cinzel({
  variable: "--font-cinzel",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const metadata: Metadata = {
  title: "Combat Sim",
  description: "Narrated D&D combat, run from a chat window.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Combat Sim",
  },
  icons: {
    apple: `${basePath}/apple-touch-icon.png`,
    icon: [`${basePath}/icon-192.png`, `${basePath}/icon-512.png`],
  },
};

export const viewport: Viewport = {
  themeColor: "#171008",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${cinzel.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
