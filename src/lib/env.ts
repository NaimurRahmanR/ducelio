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

// Learner services (docs/61 section 4). Like commerceConfig(), a SEPARATE
// accessor that only non-rendering server code may call (dispatchers, route
// handlers, server actions); nothing here is ever passed to a component except
// derived booleans. NEXT_PUBLIC_VAPID_PUBLIC_KEY is public by design (the
// browser needs it to subscribe); the private key and secrets are not.
// Unconfigured services fail closed and truthfully: mail stays QUEUED, push is
// reported unavailable, and a receipt says its seller details are missing.
const emailAddress = /^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$/;
const base64Url = /^[A-Za-z0-9_-]+$/;
export function readLearnerServicesConfig(
  env: Record<string, string | undefined>,
) {
  const emailProvider = env.EMAIL_PROVIDER?.trim().toLowerCase() || "";
  const resendApiKey = env.RESEND_API_KEY?.trim() || "";
  const emailFrom = env.EMAIL_FROM?.trim() || "";
  const emailConfigured =
    emailProvider === "resend" &&
    resendApiKey.length >= 10 &&
    emailAddress.test(emailFrom.replace(/^.*<([^>]+)>$/, "$1"));
  const vapidPublicKey = env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() || "";
  const vapidPrivateKey = env.VAPID_PRIVATE_KEY?.trim() || "";
  const vapidSubject = env.VAPID_SUBJECT?.trim() || "";
  const pushConfigured =
    base64Url.test(vapidPublicKey) &&
    vapidPublicKey.length >= 80 &&
    base64Url.test(vapidPrivateKey) &&
    vapidPrivateKey.length >= 40 &&
    (/^mailto:[^@\s]+@[^@\s]+$/.test(vapidSubject) ||
      /^https:\/\/[^\s]+$/.test(vapidSubject));
  const cronSecret = env.CRON_SECRET?.trim() || "";
  const sellerLegalName = env.SELLER_LEGAL_NAME?.trim() || "";
  const sellerAddress = env.SELLER_ADDRESS?.trim() || "";
  const sellerTaxId = env.SELLER_TAX_ID?.trim() || "";
  return {
    email: {
      provider: emailConfigured ? ("resend" as const) : null,
      resendApiKey,
      from: emailFrom,
      configured: emailConfigured,
    },
    push: {
      publicKey: vapidPublicKey,
      privateKey: vapidPrivateKey,
      subject: vapidSubject,
      configured: pushConfigured,
    },
    // Scheduled dispatch is refused unless a long shared secret exists.
    cronSecret: cronSecret.length >= 32 ? cronSecret : "",
    seller: {
      legalName: sellerLegalName,
      address: sellerAddress,
      taxId: sellerTaxId,
      configured: Boolean(sellerLegalName && sellerAddress),
    },
  };
}
export const learnerServicesConfig = () =>
  readLearnerServicesConfig(process.env);
