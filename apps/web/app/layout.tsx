import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Japan Job Agent",
  description: "検証済みの公式情報から、日本の求人を証拠付きで推薦します。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body>{children}</body></html>;
}
