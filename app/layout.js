import "./globals.css";

export const metadata = {
  title: "test.t2c",
  description: "A shared calendar your family adds to by text. No app download, no account — just open your link and type.",
  openGraph: {
    title: "test.t2c",
    description: "A shared calendar your family adds to by text. No app download, no account — just open your link and type.",
    url: "https://testt2c.vercel.app",
    siteName: "test.t2c",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "test.t2c",
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
