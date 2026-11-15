import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Company Assistant",
  description: "Internal company assistant",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
