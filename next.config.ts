import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  experimental: {
    serverActions: {
      // The default 1 MB limit counts multipart overhead, so an Academy
      // package near its 1 MiB limit (src/domain/academy-delivery.ts) was
      // dropped by the framework with no message. 1 MiB plus headroom keeps
      // the application's own size check reachable; still well below the
      // hosting platform's request limit.
      bodySizeLimit: "1200kb",
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
          },
        ],
      },
      {
        // The reminder service worker is always revalidated, so a fix
        // reaches every browser on its next visit, and may run only its
        // own same-origin script.
        source: "/sw.js",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          {
            key: "Content-Security-Policy",
            value: "default-src 'self'; script-src 'self'",
          },
        ],
      },
    ];
  },
};
export default config;
