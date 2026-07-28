import type { Metadata } from "next";
import { headers } from "next/headers";
import { Manrope, Unbounded } from "next/font/google";
import "./globals.css";

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["cyrillic", "latin"],
});

const unbounded = Unbounded({
  variable: "--font-unbounded",
  subsets: ["cyrillic", "latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const origin = host ? `${protocol}://${host}` : undefined;

  return {
    title: "КОЛЕР — агент отдела продаж завода красок",
    description:
      "Интерактивный стенд: заказ, склад, рынок, модельное ревью и управляемое коммерческое решение.",
    metadataBase: origin ? new URL(origin) : undefined,
    openGraph: {
      title: "КОЛЕР — как агент сохраняет заказ",
      description:
        "Напишите заказ и проследите, как агент проверяет факты, рынок и границы полномочий.",
      type: "website",
      images: origin ? [{ url: `${origin}/og.png`, width: 1200, height: 630 }] : [],
    },
    twitter: {
      card: "summary_large_image",
      title: "КОЛЕР — агент отдела продаж",
      description: "Живой агентный процесс от письма до решения.",
      images: origin ? [`${origin}/og.png`] : [],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body className={`${manrope.variable} ${unbounded.variable}`}>
        {children}
      </body>
    </html>
  );
}
