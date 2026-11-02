import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE_URL = "https://www.neuralboard.org";
const DESCRIPTION = "AI-powered video moodboard builder";

// Icons come from the app/ file conventions (favicon.ico, icon.png, icon.svg, apple-icon.png),
// which Next turns into <link> tags and which take priority over a metadata `icons` field.
// og-image.png and favicon.svg are generated from public/logo.svg by scripts/generate-brand-images.mjs.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Neural Board",
  description: DESCRIPTION,
  openGraph: {
    title: "Neural Board",
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: "Neural Board",
    type: "website",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Neural Board" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Neural Board",
    description: DESCRIPTION,
    images: ["/og-image.png"],
  },
};

// Lets Google associate the logo with the site (Organization structured data).
const ORGANIZATION_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Neural Board",
  url: SITE_URL,
  logo: `${SITE_URL}/logo.svg`,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Caveat:wght@400;700&family=Permanent+Marker&family=Architects+Daughter&family=Patrick+Hand&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-full flex flex-col">
        {/* JSON-LD as a plain script tag, as the Next.js docs recommend; "<" escaped against injection. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(ORGANIZATION_JSON_LD).replace(/</g, "\\u003c") }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
