import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: {
    default: "Ducelio · Your ambition. Guided to mastery.",
    template: "%s · Ducelio",
  },
  description:
    "Your digital academy for structured learning, objective-level mastery and continuous learner support.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
