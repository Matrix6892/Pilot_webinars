import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geologica, Golos_Text } from "next/font/google";
import "./globals.css";

const golos = Golos_Text({
  variable: "--font-golos",
  subsets: ["cyrillic", "latin"],
});

const geologica = Geologica({
  variable: "--font-geologica",
  subsets: ["cyrillic", "latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const origin = host ? `${protocol}://${host}` : undefined;

  return {
    title: "Колер — агент отдела продаж завода красок",
    description:
      "Интерактивный стенд: заказ, склад, демонстрационный рынок, ИИ-проверка и управляемое коммерческое решение.",
    metadataBase: origin ? new URL(origin) : undefined,
    openGraph: {
      title: "Колер — как агент сохраняет заказ",
      description:
        "Напишите заказ и проследите, как агент проверяет факты, демонстрационный рынок и границы полномочий.",
      type: "website",
      images: origin ? [{ url: `${origin}/og.png`, width: 1200, height: 630 }] : [],
    },
    twitter: {
      card: "summary_large_image",
      title: "Колер — агент отдела продаж",
      description: "Интерактивный путь заказа от письма до решения.",
      images: origin ? [`${origin}/og.png`] : [],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body className={`${golos.variable} ${geologica.variable}`}>
        {children}
      </body>
    </html>
  );
}
