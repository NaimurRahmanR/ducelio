"use server";
import type {
  InterpretResult,
  PrepareResult,
  Receipt,
} from "@/server/operations-engineer";
export type ActionError = { status: "FORBIDDEN" | "ERROR"; message: string };
const retired = (): ActionError => ({
  status: "ERROR",
  message:
    "This workflow has retired. Use Course Engineering for courses and course coupons for discounts.",
});
export async function prepareOperationAction(
  _actionId: string,
  _raw: Record<string, string>,
): Promise<PrepareResult | ActionError> {
  void _actionId;
  void _raw;
  return retired();
}
export async function interpretRequestAction(
  _text: string,
): Promise<InterpretResult | ActionError> {
  void _text;
  return retired();
}
export async function executeOperationAction(_request: {
  actionId: string;
  raw: Record<string, string>;
  issuedAt: string;
  nonce: string;
  proposalId: string;
  confirmed: boolean;
}): Promise<Receipt | ActionError> {
  void _request;
  return retired();
}
