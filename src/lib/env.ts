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

// PR13 commerce configuration. Deliberately a SEPARATE accessor from
// config() above -- config()'s return value is read directly inside JSX by
// server components (e.g. AuthPage), and nothing here may ever reach a
// Client Component as props. Call commerceConfig() only from non-rendering
// server code (server actions, route handlers, the Stripe adapter) and
// surface only the boolean `configured`/`stripeConfigured` flags to any
// JSX. When Stripe/controller configuration is absent, public course
// browsing still works; checkout fails closed and truthfully -- it never
// simulates a successful payment.
const hexKey64 = /^[0-9a-f]{64}$/i;
// RFC 4122-shaped only -- a malformed non-empty key id (or a hex key of
// the wrong length/charset) must never make checkout appear production-
// ready (V2 correction, finding 2).
const uuidLike =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function readCommerceConfig(env: Record<string, string | undefined>) {
  const stripeSecretKey = env.STRIPE_SECRET_KEY?.trim() || "";
  const stripeWebhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() || "";
  const controllerKeyId = env.COMMERCE_CONTROLLER_KEY_ID?.trim() || "";
  const controllerKeyHex = env.COMMERCE_CONTROLLER_HMAC_KEY_HEX?.trim() || "";
  const stripeConfigured = Boolean(stripeSecretKey && stripeWebhookSecret);
  const controllerConfigured = Boolean(
    uuidLike.test(controllerKeyId) && hexKey64.test(controllerKeyHex),
  );
  return {
    stripeSecretKey,
    stripeWebhookSecret,
    controllerKeyId,
    controllerKeyHex,
    stripeConfigured,
    controllerConfigured,
    configured: stripeConfigured && controllerConfigured,
  };
}
export const commerceConfig = () => readCommerceConfig(process.env);
