import "./globals.css";

export const metadata = {
  title: "Family Calendar",
  description: "A shared calendar your family can text activities into.",
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
