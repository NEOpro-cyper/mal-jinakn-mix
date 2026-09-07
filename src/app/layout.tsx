import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Anime API — Official MAL v2 + AniList",
  description: "MyAnimeList-backed anime API with AniList GraphQL fallback for characters and Miruro for streaming servers.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
