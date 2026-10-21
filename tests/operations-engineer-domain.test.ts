import { describe, expect, it } from "vitest";
import {
  DUPLICATE_PROTECTION,
  OPERATIONS_ENGINEER_CAPABILITY,
  OPERATION_ACTIONS,
  composeOperationsEngineerInstructions,
  isOperationEnabled,
  majorToMinor,
  operationActionIds,
  parseActionInput,
  parseInterpreterOutput,
} from "@/domain/operations-engineer";
import {
  isOperationsEngineerCapabilityAllowed,
  OPERATIONS_ENGINEER_PROHIBITED_SCOPES,
} from "@/domain/platform-ai-policy";
import { providerInstructions } from "@/server/academic-runtime/provider";

const reason = "Quarterly pricing review";
const activationId = "50000000-0000-4000-8000-000000000001";

describe("action registry", () => {
  it("is closed, and every change is admin-only with consequence and recovery text", () => {
    expect(operationActionIds).toHaveLength(12);
    for (const id of operationActionIds) {
      const a = OPERATION_ACTIONS[id];
      expect(a.roles).toEqual(["ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
      if (a.kind === "MUTATION") {
        expect(a.consequence).toBeTruthy();
        expect(a.recovery).toBeTruthy();
      }
    }
    expect(JSON.stringify(OPERATION_ACTIONS)).not.toMatch(
      /\b(sql|shell|secrets?|deploy|merge|refund)\b/i,
    );
  });

  it("registers interpretation as a proposal-only platform capability", () => {
    expect(
      isOperationsEngineerCapabilityAllowed(OPERATIONS_ENGINEER_CAPABILITY),
    ).toBe(true);
    for (const scope of OPERATIONS_ENGINEER_PROHIBITED_SCOPES)
      expect(isOperationsEngineerCapabilityAllowed(scope)).toBe(false);
  });
});

describe("money and input parsing", () => {
  it.each([
    ["249", 24900],
    ["249.5", 24950],
    ["249.50", 24950],
    ["1,249.99", 124999],
    ["0.01", 1],
  ])("converts %s exactly to %i minor units", (text, minor) => {
    expect(majorToMinor(text)).toBe(minor);
  });

  it.each(["", "12.345", "-5", "1e3", "twelve"])("rejects %j", (text) => {
    expect(majorToMinor(text)).toBeNull();
  });

  it("produces the exact governed publish input", () => {
    expect(
      parseActionInput("publish_offer", {
        activationId,
        slug: " Security-Plus-Autumn ",
        price: "249.00",
        currency: "gbp",
        deliveryPlan: "INTENSIVE_4_WEEK",
        summary: "",
        reason,
      }),
    ).toEqual({
      ok: true,
      input: {
        activationId,
        slug: "security-plus-autumn",
        priceAmountMinor: 24900,
        currency: "GBP",
        summary: null,
        deliveryPlan: "INTENSIVE_4_WEEK",
        reason,
      },
    });
  });

  it("only offers two-decimal currencies, matching how prices are displayed", () => {
    const result = parseActionInput("publish_offer", {
      activationId,
      slug: "x-course",
      price: "1000",
      currency: "JPY",
      reason,
    });
    expect(result.ok).toBe(false);
  });

  it("requires a meaningful reason within the audit limit", () => {
    expect(
      parseActionInput("archive_offer", { slug: "x-course", reason: "no" }).ok,
    ).toBe(false);
    expect(
      parseActionInput("archive_offer", {
        slug: "x-course",
        reason: "x".repeat(271),
      }).ok,
    ).toBe(false);
  });

  it("keeps free access to the explicit reviewer campaign kind", () => {
    const common = {
      offerSlug: "x-course",
      code: "LAUNCH-20",
      maxRedemptions: "50",
      startsAt: "2026-11-01T09:00",
      endsAt: "2026-12-01T09:00",
      reason,
    };
    expect(
      parseActionInput("create_campaign", {
        ...common,
        kind: "PERCENT_OFF",
        percentOff: "100",
      }).ok,
    ).toBe(false);
    const percent = parseActionInput("create_campaign", {
      ...common,
      kind: "PERCENT_OFF",
      percentOff: "20",
    });
    expect(percent).toMatchObject({
      ok: true,
      input: {
        kind: "PERCENT_OFF",
        percentOff: 20,
        startsAt: "2026-11-01T09:00:00.000Z",
      },
    });
    expect(
      parseActionInput("create_campaign", {
        ...common,
        kind: "FIXED_PRICE",
        fixedPrice: "199.00",
      }),
    ).toMatchObject({ ok: true, input: { fixedPriceAmountMinor: 19900 } });
    expect(
      parseActionInput("create_campaign", {
        ...common,
        kind: "REVIEWER_COMPLIMENTARY",
      }).ok,
    ).toBe(true);
    expect(
      parseActionInput("create_campaign", {
        ...common,
        kind: "PERCENT_OFF",
        percentOff: "20",
        endsAt: "2026-10-01T09:00",
      }).ok,
    ).toBe(false);
  });

  it("validates cohort transitions' input and identifiers", () => {
    expect(
      parseActionInput("change_cohort_status", {
        cohortId: "nope",
        status: "CLOSED",
        reason,
      }).ok,
    ).toBe(false);
    expect(
      parseActionInput("change_cohort_status", {
        cohortId: activationId,
        status: "DELETED",
        reason,
      }).ok,
    ).toBe(false);
  });
});

describe("interpreter contract", () => {
  it("accepts only the strict JSON shape", () => {
    expect(
      parseInterpreterOutput(
        '```json\n{"action":"list_offers","arguments":{},"explanation":"Lists offers."}\n```',
      ),
    ).toEqual({
      action: "list_offers",
      arguments: {},
      explanation: "Lists offers.",
    });
    expect(
      parseInterpreterOutput('{"action":"none","explanation":"Out of scope."}'),
    ).toMatchObject({ action: "none" });
    expect(parseInterpreterOutput("Sure! I published it.")).toBeNull();
    expect(
      parseInterpreterOutput(
        '{"action":"drop_table","arguments":{},"explanation":"x"}',
      ),
    ).toBeNull();
    expect(
      parseInterpreterOutput(
        '{"action":"list_offers","arguments":{},"explanation":"x","execute":true}',
      ),
    ).toBeNull();
  });

  it("gives the model only the closed registry and the no-execution rule", () => {
    const text = composeOperationsEngineerInstructions();
    // Every enabled action, and no disabled one.
    for (const id of operationActionIds)
      if (isOperationEnabled(id)) expect(text).toContain(`- ${id} [`);
      else expect(text).not.toContain(`- ${id} [`);
    expect(text).toContain("You never execute anything");
    expect(text).toContain('return action "none"');
    expect(text).toContain("Never invent identifiers");
  });

  it("routes the Operations Engineer to its own instructions, never the academic ones", () => {
    const text = providerInstructions({
      role: "OPERATIONS_ENGINEER",
      capability: OPERATIONS_ENGINEER_CAPABILITY,
      context: {},
      constraints: { maxOutputTokens: 1200 },
    });
    expect(text).toBe(composeOperationsEngineerInstructions());
  });
});

describe("duplicate protection is stated honestly", () => {
  it("names a database guarantee only where an invariant provides one", () => {
    const levels = Object.fromEntries(
      Object.entries(DUPLICATE_PROTECTION).map(([id, p]) => [id, p.level]),
    );
    expect(levels).toMatchObject({
      publish_offer: "database",
      create_campaign: "database",
      archive_campaign: "database",
      // No status revision: a reopen makes an old close match again.
      change_cohort_status: "partial",
      // No row lock: simultaneous confirmations could each record an event.
      archive_offer: "partial",
      // Serialised, but two confirmations would record two runs.
      run_course_test: "partial",
    });
    for (const id of operationActionIds)
      expect(DUPLICATE_PROTECTION[id].text.length).toBeGreaterThan(0);
    for (const id of operationActionIds.filter(
      (a) => OPERATION_ACTIONS[a].kind === "READ",
    ))
      expect(DUPLICATE_PROTECTION[id].level).toBe("read-only");
  });
});

describe("what the Operations Engineer will carry out", () => {
  it("disables exactly the changes whose protection is only partial", () => {
    for (const id of operationActionIds)
      expect(isOperationEnabled(id)).toBe(
        DUPLICATE_PROTECTION[id].level !== "partial",
      );
    expect(isOperationEnabled("change_cohort_status")).toBe(false);
  });
});
