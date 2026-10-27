"use server";
import {
  submitSupportMessageAction,
  type SupportActionState,
} from "@/app/student/_actions/support-actions";

// Support & Feedback page action: the support service action, which saves
// the message and reports the real outbox delivery state.
export async function sendMySupportMessageAction(
  previous: SupportActionState,
  form: FormData,
): Promise<SupportActionState> {
  return submitSupportMessageAction(previous, form);
}
