import { z } from "zod";
const httpUrl = z
  .url()
  .refine(
    (value) => ["http:", "https:"].includes(new URL(value).protocol),
    "Expected an HTTP(S) URL",
  );
export function readConfig(env: Record<string, string | undefined>) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const configured = Boolean(url && key);
  if (url) httpUrl.parse(url);
  const appUrl = httpUrl.parse(env.APP_URL || "http://127.0.0.1:3000");
  if (new URL(appUrl).origin !== appUrl)
    throw new Error(
      "APP_URL must be an origin without path, credentials, query or trailing slash.",
    );
  if (
    env.NODE_ENV === "production" &&
    configured &&
    !appUrl.startsWith("https://")
  ) {
    throw new Error(
      "Configured production authentication requires an HTTPS APP_URL.",
    );
  }
  return {
    url: url || "",
    key: key || "",
    configured,
    appUrl,
    google: configured && env.AUTH_GOOGLE_ENABLED === "true",
    linkedin: configured && env.AUTH_LINKEDIN_ENABLED === "true",
  };
}
export const config = () => readConfig(process.env);
