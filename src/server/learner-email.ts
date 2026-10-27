import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { commerceConfig, config, learnerServicesConfig } from "@/lib/env";
import {
  certificateSchema,
  renderCertificatePdf,
} from "./learner-certificates";
import {
  receiptSchema,
  renderReceiptPdf,
  sellerIdentity,
  type SellerIdentity,
} from "./learner-receipts";

// Learner email outbox (docs/61 section 4). Producers (support, certificate,
// receipt RPCs) enqueue inside the database with an idempotency key. This
// dispatcher claims due messages through the HMAC-attested surface of
// migration 076 (the reviewed commerce controller key under the distinct
// DUCELIO_LEARNER_SERVICES purpose tag), hands each to the configured
// provider and records SENT only with the provider's message id. With no
// provider configured nothing is claimed: mail stays QUEUED and the learner
// is told delivery is pending. Never reported as sent without a provider
// acknowledgement.

export const LEARNER_DISPATCH_PURPOSE =
  "DUCELIO_LEARNER_SERVICES_HMAC_SHA256_V1";
export type DispatchController = { keyId: string; secret: Buffer };
export type LearnerRpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export function dispatchController(): DispatchController | null {
  const env = commerceConfig();
  if (!env.controllerConfigured) return null;
  return {
    keyId: env.controllerKeyId.toLowerCase(),
    secret: Buffer.from(env.controllerKeyHex, "hex"),
  };
}

// The canonical string mirrors learner_private.verify_dispatch exactly.
export function signDispatch(
  controller: DispatchController,
  canonical: string,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const issuedAt = nowSeconds;
  const expiresAt = issuedAt + 60;
  const mac = createHmac("sha256", controller.secret)
    .update(
      [
        LEARNER_DISPATCH_PURPOSE,
        controller.keyId,
        canonical,
        String(issuedAt),
        String(expiresAt),
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
  return {
    p_key_id: controller.keyId,
    p_issued_at: issuedAt,
    p_expires_at: expiresAt,
    p_mac: mac,
  };
}

export class LearnerDispatchUnavailable extends Error {
  constructor(readonly code = "DISPATCH_UNAVAILABLE") {
    super(code);
    this.name = "LearnerDispatchUnavailable";
  }
}

// A cookie-less publishable-key client (the anon role) for scheduled
// dispatch. It carries no session and no service-role credential; the HMAC
// claim is its only authority.
export function anonymousLearnerRpc(): LearnerRpc {
  const env = config();
  if (!env.configured) throw new LearnerDispatchUnavailable("NOT_CONFIGURED");
  const client = createClient(env.url, env.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return async (fn, args) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new LearnerDispatchUnavailable();
    return data;
  };
}

// Scheduled routes: Authorization: Bearer <CRON_SECRET> (the Vercel Cron
// convention) or X-Cron-Secret. Constant-time comparison; refused when no
// sufficiently long secret is configured.
export function cronAuthorized(headers: Headers, secret: string) {
  if (!secret) return false;
  const bearer = headers.get("authorization");
  const supplied =
    (bearer?.startsWith("Bearer ") ? bearer.slice(7) : null) ??
    headers.get("x-cron-secret") ??
    "";
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(secret, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type OutgoingEmail = {
  idempotencyKey: string;
  to: string;
  replyTo: string | null;
  subject: string;
  text: string;
  attachments: { filename: string; contentType: string; content: Uint8Array }[];
};
export interface EmailAdapter {
  readonly name: string;
  send(email: OutgoingEmail): Promise<{ providerMessageId: string }>;
}
export class EmailDeliveryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EmailDeliveryError";
  }
}

// Resend HTTP API. The provider response body is never stored (it can echo
// recipient data); only a short status code is recorded on failure.
export function createResendAdapter(
  settings: { apiKey: string; from: string },
  fetchImpl: typeof fetch = fetch,
): EmailAdapter {
  return {
    name: "resend",
    async send(email) {
      let response: Response;
      try {
        response = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${settings.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": email.idempotencyKey,
          },
          body: JSON.stringify({
            from: settings.from,
            to: [email.to],
            subject: email.subject,
            text: email.text,
            ...(email.replyTo ? { reply_to: email.replyTo } : {}),
            ...(email.attachments.length
              ? {
                  attachments: email.attachments.map((a) => ({
                    filename: a.filename,
                    content: Buffer.from(a.content).toString("base64"),
                    content_type: a.contentType,
                  })),
                }
              : {}),
          }),
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        throw new EmailDeliveryError("PROVIDER_UNREACHABLE");
      }
      if (!response.ok)
        throw new EmailDeliveryError(`PROVIDER_HTTP_${response.status}`);
      const body = z
        .object({ id: z.string().min(1).max(200) })
        .safeParse(await response.json().catch(() => null));
      if (!body.success) throw new EmailDeliveryError("PROVIDER_NO_ACK");
      return { providerMessageId: body.data.id };
    },
  };
}

export function selectEmailAdapter(
  settings = learnerServicesConfig().email,
): EmailAdapter | null {
  if (settings.configured && settings.provider === "resend")
    return createResendAdapter({
      apiKey: settings.resendApiKey,
      from: settings.from,
    });
  return null;
}

export const claimedEmailSchema = z.object({
  id: z.uuid(),
  attempt: z.number().int().min(1),
  kind: z.enum(["SUPPORT_MESSAGE", "CERTIFICATE_ISSUED", "PAYMENT_RECEIPT"]),
  recipient: z.string(),
  replyTo: z.string().nullable(),
  subject: z.string(),
  bodyText: z.string(),
  attachment: z
    .object({ kind: z.enum(["CERTIFICATE", "RECEIPT"]), data: z.unknown() })
    .nullable(),
});
export type ClaimedEmail = z.infer<typeof claimedEmailSchema>;

export type AttachmentRenderer = (
  attachment: NonNullable<ClaimedEmail["attachment"]>,
) => Promise<OutgoingEmail["attachments"][number]>;

export function defaultAttachmentRenderer(options: {
  appUrl: string;
  seller: SellerIdentity;
}): AttachmentRenderer {
  return async (attachment) => {
    if (attachment.kind === "CERTIFICATE") {
      const certificate = certificateSchema.parse(attachment.data);
      return {
        filename: `ducelio-certificate-${certificate.verificationCode}.pdf`,
        contentType: "application/pdf",
        content: await renderCertificatePdf(certificate, options),
      };
    }
    const receipt = receiptSchema.parse(attachment.data);
    return {
      filename: `ducelio-receipt-${receipt.receiptNumber}.pdf`,
      contentType: "application/pdf",
      content: await renderReceiptPdf(receipt, options.seller),
    };
  };
}

export type EmailDispatchSummary = {
  configured: boolean;
  claimed: number;
  sent: number;
  retrying: number;
  failed: number;
};

export async function dispatchLearnerEmail(options: {
  rpc: LearnerRpc;
  controller: DispatchController | null;
  adapter: EmailAdapter | null;
  appUrl: string;
  renderAttachment?: AttachmentRenderer;
  limit?: number;
  now?: () => number;
}): Promise<EmailDispatchSummary> {
  const summary: EmailDispatchSummary = {
    configured: Boolean(options.adapter && options.controller),
    claimed: 0,
    sent: 0,
    retrying: 0,
    failed: 0,
  };
  // Unconfigured: claim nothing, so every message stays QUEUED.
  if (!options.adapter || !options.controller) return summary;
  const { adapter, controller, rpc } = options;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const render =
    options.renderAttachment ??
    defaultAttachmentRenderer({
      appUrl: options.appUrl,
      seller: sellerIdentity(),
    });
  const claim = z
    .union([
      z.object({ ok: z.literal(true), messages: z.array(claimedEmailSchema) }),
      z.object({ ok: z.literal(false), code: z.string() }),
    ])
    .parse(
      await rpc("claim_learner_email_batch", {
        p_limit: limit,
        ...signDispatch(controller, `CLAIM_EMAIL\n${limit}`, now()),
      }),
    );
  if (!claim.ok) throw new LearnerDispatchUnavailable(claim.code);
  summary.claimed = claim.messages.length;
  for (const message of claim.messages) {
    let outcome: "SENT" | "FAILED";
    let providerMessageId: string | null = null;
    let failure: string | null = null;
    try {
      const attachments = message.attachment
        ? [await render(message.attachment)]
        : [];
      const result = await adapter.send({
        idempotencyKey: `ducelio-outbox-${message.id}`,
        to: message.recipient,
        replyTo: message.replyTo,
        subject: message.subject,
        text: message.bodyText.replaceAll("{{APP_URL}}", options.appUrl),
        attachments,
      });
      outcome = "SENT";
      providerMessageId = result.providerMessageId;
    } catch (error) {
      outcome = "FAILED";
      failure =
        error instanceof EmailDeliveryError ? error.code : "DELIVERY_FAILED";
    }
    const recorded = z
      .object({ ok: z.boolean(), status: z.string().optional() })
      .parse(
        await rpc("complete_learner_email", {
          p_message_id: message.id,
          p_attempt: message.attempt,
          p_outcome: outcome,
          p_provider_message_id: providerMessageId,
          p_error: failure,
          ...signDispatch(
            controller,
            [
              "COMPLETE_EMAIL",
              message.id,
              String(message.attempt),
              outcome,
              providerMessageId ?? "",
              failure ?? "",
            ].join("\n"),
            now(),
          ),
        }),
      );
    if (!recorded.ok) continue;
    if (recorded.status === "SENT") summary.sent += 1;
    else if (recorded.status === "FAILED") summary.failed += 1;
    else summary.retrying += 1;
  }
  return summary;
}

// Production entry point for the scheduled route.
export async function runLearnerEmailDispatch() {
  return dispatchLearnerEmail({
    rpc: anonymousLearnerRpc(),
    controller: dispatchController(),
    adapter: selectEmailAdapter(),
    appUrl: config().appUrl,
  });
}
