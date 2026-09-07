import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Transcriptor",
  description: "Convierte tus videos en texto.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
