import "server-only";
import { z } from "zod";
import { requireAnyRole } from "../identity";
import { createSupabase } from "../supabase";
import { commerceOperationInputSchema } from "@/domain/commercial-v1-commerce-operations";
import { getCommerceProvider } from "./provider";
import { processCommerceWebhook } from "./webhooks";

export async function retryCommerceWebhook(input: unknown) {
  await requireAnyRole(["ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
  const { id, reason } = commerceOperationInputSchema.parse(input);
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "admin_prepare_commercial_v1_webhook_retry",
    { p_receipt_id: id, p_reason: reason },
  );
  if (error) throw new Error("Webhook recovery could not be authorised.");
  const eventId = z.string().min(1).max(200).parse(data);
  try {
    const provider = await getCommerceProvider();
    const event = await provider.retrieveWebhookEvent(eventId);
    if (event.eventId !== eventId) throw new Error("Event mismatch");
    const result = await processCommerceWebhook(event, provider);
    return {
      ok: result.reconciled,
      code: result.reconciled
        ? "WEBHOOK_RECONCILED"
        : "WEBHOOK_REMAINS_UNRESOLVED",
    };
  } catch {
    return { ok: false, code: "WEBHOOK_RECOVERY_UNAVAILABLE" };
  }
}
