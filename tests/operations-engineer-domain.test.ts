import { describe, expect, it } from "vitest";
import {
  DUPLICATE_PROTECTION,
  OPERATIONS_ENGINEER_CAPABILITY,
  OPERATION_ACTIONS,
  composeOperationsEngineerInstructions,
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
const packageId = "50000000-0000-4000-8000-000000000001";
const organisationId = "00000000-0000-4000-8000-000000000001";
const future = "2031-01-01T09:00";

describe("action registry", () => {
  it("is closed, targets only the unified engine and states every change's consequence and recovery", () => {
    expect([...operationActionIds]).toEqual([
      "list_courses",
      "inspect_course",
      "list_coupons",
      "sales_report",
      "check_agent_health",
      "upload_course_package",
      "publish_course",
      "create_coupon",
      "set_coupon_active",
    ]);
    for (const id of operationActionIds) {
      const a = OPERATION_ACTIONS[id];
      if (a.kind === "MUTATION") {
        expect(a.consequence).toBeTruthy();
        expect(a.recovery).toBeTruthy();
      }
    }
    // No retired cohort, campaign or commercial-offer operation survives.
    expect(JSON.stringify(OPERATION_ACTIONS)).not.toMatch(
      /\b(cohorts?|campaigns?|activations?|sql|shell|secrets?|deploy|merge)\b/i,
    );
    // Refunds may be reported, never carried out; nor grades or enrolments.
    expect(operationActionIds.join(" ")).not.toMatch(/refund|grade|enrol/i);
    expect(OPERATION_ACTIONS.check_agent_health.roles).toEqual([
      "ACADEMIC_ADMIN",
      "PLATFORM_ADMIN",
    ]);
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

  it("produces the exact governed publication input", () => {
    expect(
      parseActionInput("publish_course", {
        packageId,
        slug: " aws-saa-c03 ",
        price: "249.00",
        currency: "gbp",
        summary: "",
        reason,
      }),
    ).toEqual({
      ok: true,
      input: {
        packageId,
        slug: "aws-saa-c03",
        currency: "GBP",
        amountMinor: 24900,
        summary: null,
        reason,
      },
    });
    for (const bad of [
      { currency: "JPY" },
      { price: "0" },
      { slug: "Not A Slug" },
      { packageId: "nope" },
    ])
      expect(
        parseActionInput("publish_course", {
          packageId,
          slug: "aws-saa-c03",
          price: "249.00",
          currency: "GBP",
          reason,
          ...bad,
        }).ok,
      ).toBe(false);
  });

  it("requires a meaningful reason within the audit limit for every change", () => {
    for (const r of ["no", "x".repeat(271)]) {
      expect(
        parseActionInput("upload_course_package", { organisationId, reason: r })
          .ok,
      ).toBe(false);
      expect(
        parseActionInput("set_coupon_active", {
          couponId: packageId,
          active: "false",
          reason: r,
        }).ok,
      ).toBe(false);
    }
  });

  it("parses a percentage or a fixed-amount coupon, never both", () => {
    const common = {
      organisationId,
      code: " launch-20 ",
      expiresAt: future,
      redemptionLimit: "50",
      courseId: "",
      reason,
    };
    expect(
      parseActionInput("create_coupon", {
        ...common,
        discountKind: "PERCENT",
        percentOff: "20",
        amountOff: "10.00",
        currency: "GBP",
      }),
    ).toEqual({
      ok: true,
      input: {
        organisationId,
        code: "LAUNCH-20",
        expiresAt: "2031-01-01T09:00:00.000Z",
        redemptionLimit: 50,
        courseId: null,
        reason,
        percentOff: 20,
      },
    });
    expect(
      parseActionInput("create_coupon", {
        ...common,
        discountKind: "AMOUNT",
        amountOff: "25.50",
        currency: "eur",
      }),
    ).toMatchObject({
      ok: true,
      input: { amountOffMinor: 2550, currency: "EUR" },
    });
    for (const bad of [
      { discountKind: "PERCENT", percentOff: "0" },
      { discountKind: "PERCENT", percentOff: "101" },
      { discountKind: "AMOUNT", amountOff: "0", currency: "GBP" },
      { discountKind: "AMOUNT", amountOff: "5", currency: "JPY" },
      { discountKind: "FREE" },
      { discountKind: "PERCENT", percentOff: "10", code: "x" },
      { discountKind: "PERCENT", percentOff: "10", expiresAt: "" },
    ])
      expect(parseActionInput("create_coupon", { ...common, ...bad }).ok).toBe(
        false,
      );
  });

  it("accepts only an explicit availability for a coupon", () => {
    expect(
      parseActionInput("set_coupon_active", {
        couponId: packageId,
        active: "false",
        reason,
      }),
    ).toEqual({
      ok: true,
      input: { couponId: packageId, active: false, reason },
    });
    expect(
      parseActionInput("set_coupon_active", {
        couponId: packageId,
        active: "yes",
        reason,
      }).ok,
    ).toBe(false);
  });
});

describe("interpreter contract", () => {
  it("accepts only the strict JSON shape", () => {
    expect(
      parseInterpreterOutput(
        '```json\n{"action":"list_courses","arguments":{},"explanation":"Lists courses."}\n```',
      ),
    ).toEqual({
      action: "list_courses",
      arguments: {},
      explanation: "Lists courses.",
    });
    expect(
      parseInterpreterOutput('{"action":"none","explanation":"Out of scope."}'),
    ).toMatchObject({ action: "none" });
    expect(parseInterpreterOutput("Sure! I published it.")).toBeNull();
    for (const retired of ["drop_table", "publish_offer", "create_campaign"])
      expect(
        parseInterpreterOutput(
          `{"action":"${retired}","arguments":{},"explanation":"x"}`,
        ),
      ).toBeNull();
    expect(
      parseInterpreterOutput(
        '{"action":"list_courses","arguments":{},"explanation":"x","execute":true}',
      ),
    ).toBeNull();
  });

  it("gives the model only the closed registry, no file access and no approval authority", () => {
    const text = composeOperationsEngineerInstructions();
    for (const id of operationActionIds) expect(text).toContain(`- ${id} [`);
    expect(text).toContain("You never execute anything");
    expect(text).toContain('return action "none"');
    expect(text).toContain("Never invent identifiers");
    expect(text).toContain("You cannot see files");
    expect(text).toContain("You cannot approve academic decisions");
    // The file field itself is never described to the model as an argument.
    expect(text).not.toContain("package (Course package file");
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
    expect(levels).toEqual({
      list_courses: "read-only",
      inspect_course: "read-only",
      list_coupons: "read-only",
      sales_report: "read-only",
      check_agent_health: "read-only",
      upload_course_package: "database",
      publish_course: "database",
      create_coupon: "database",
      // No availability revision: a change and change-back makes a stale
      // proposal match again. Its replay can only re-apply the confirmed,
      // reversible availability; it has no other effect.
      set_coupon_active: "partial",
    });
    for (const id of operationActionIds)
      expect(DUPLICATE_PROTECTION[id].text.length).toBeGreaterThan(0);
  });
});
