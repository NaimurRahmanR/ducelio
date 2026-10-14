import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { commerceConfig } from "@/lib/env";
import {
  commerceSignedOperationSchema,
  commerceOperationResultSchema,
  type CommerceSignedOperation,
} from "@/domain/commercial-v1-commerce-operations";
import { createSupabase } from "../supabase";
import { CommerceFulfillmentUnavailable } from "./authority";

// Server-only: never export a Server Action that accepts this envelope. Callers
// derive provider facts themselves and bind operator identity from authentication.
export async function attestCommerceOperation(input: CommerceSignedOperation) {
  const payload = JSON.stringify(commerceSignedOperationSchema.parse(input));
  const env = commerceConfig();
  if (!env.controllerConfigured) throw new CommerceFulfillmentUnavailable();
  const keyId = z.uuid().parse(env.controllerKeyId).toLowerCase();
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 60;
  const mac = createHmac("sha256", Buffer.from(env.controllerKeyHex, "hex"))
    .update(
      [
        "DUCELIO_COMMERCE_OPERATIONS_HMAC_SHA256_V1",
        keyId,
        payload,
        String(issuedAt),
        String(expiresAt),
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "apply_commercial_v1_commerce_operation",
    {
      p_key_id: keyId,
      p_payload: payload,
      p_issued_at: issuedAt,
      p_expires_at: expiresAt,
      p_mac: mac,
    },
  );
  if (error) throw new CommerceFulfillmentUnavailable();
  return commerceOperationResultSchema.parse(data);
}

// LR-03 (migration 058). Server-only, like attestCommerceOperation: callers
// sign only after the provider itself reported the bound session EXPIRED and
// unpaid. The database binds learnerId to the calling learner and the order.
const checkoutReplacementSchema = z.strictObject({
  learnerId: z.uuid(),
  orderId: z.uuid(),
  expiredSessionId: z.string().min(1).max(200),
  replacementSessionId: z.string().regex(/^cs_[A-Za-z0-9_]{1,197}$/),
});
export const checkoutReplacementResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    code: z.enum(["REPLACED", "ALREADY_REPLACED"]),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum([
      "UNAUTHENTICATED",
      "NOT_FOUND_OR_FORBIDDEN",
      "INVALID_STATE",
      "SESSION_CHANGED",
    ]),
  }),
]);
export async function attestCheckoutSessionReplacement(
  input: z.input<typeof checkoutReplacementSchema>,
) {
  const parsed = checkoutReplacementSchema.parse(input);
  const payload = JSON.stringify({
    learnerId: parsed.learnerId,
    orderId: parsed.orderId,
    expiredSessionId: parsed.expiredSessionId,
    replacementSessionId: parsed.replacementSessionId,
  });
  const env = commerceConfig();
  if (!env.controllerConfigured) throw new CommerceFulfillmentUnavailable();
  const keyId = z.uuid().parse(env.controllerKeyId).toLowerCase();
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 60;
  const mac = createHmac("sha256", Buffer.from(env.controllerKeyHex, "hex"))
    .update(
      [
        "DUCELIO_COMMERCE_CHECKOUT_REBIND_HMAC_SHA256_V1",
        keyId,
        payload,
        String(issuedAt),
        String(expiresAt),
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "replace_expired_commercial_v1_checkout_session",
    {
      p_key_id: keyId,
      p_payload: payload,
      p_issued_at: issuedAt,
      p_expires_at: expiresAt,
      p_mac: mac,
    },
  );
  if (error) throw new CommerceFulfillmentUnavailable();
  return checkoutReplacementResultSchema.parse(data);
}
