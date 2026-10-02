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
