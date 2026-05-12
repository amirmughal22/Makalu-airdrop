import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { SiteShell } from "@/components/SiteShell";
import { resolvedChainName } from "@/lib/chain";

export async function generateMetadata(): Promise<Metadata> {
  const name = resolvedChainName();
  return {
    title: `Airdrop Suite — ${name}`,
    description: `Verified batched airdrops on ${name}.`,
    robots: {
      index: false,
      follow: false,
      nocache: true,
      googleBot: { index: false, follow: false },
    },
    icons: {
      icon: "/litho-logo.png",
      shortcut: "/litho-logo.png",
      apple: "/litho-logo.png",
    },
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('makalu-theme');var r=document.documentElement;if(t==='light')r.classList.remove('dark');else r.classList.add('dark');}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-screen bg-slate-50 text-slate-900 dark:bg-[#000000] dark:text-slate-200">
        <SiteShell>{children}</SiteShell>
      </body>
    </html>
  );
}
