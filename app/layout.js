import "./globals.css";

export const metadata = {
  title: "text2cal",
  description: "A shared calendar your family adds to by text. No app download, no account — just open your link and type.",
  openGraph: {
    title: "text2cal",
    description: "A shared calendar your family adds to by text. No app download, no account — just open your link and type.",
    url: "https://text2cal-one.vercel.app",
    siteName: "text2cal",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "text2cal",
    description: "A shared calendar your family adds to by text. No app download, no account — just open your link and type.",
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
