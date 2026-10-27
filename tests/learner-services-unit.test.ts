import { describe, expect, it } from "vitest";
import {
  checkPrivateFile,
  sanitizeFileName,
  sniffContentType,
} from "@/server/learner-files";
import {
  formFieldName,
  learnerProfileInputSchema,
  profileInputFromForm,
} from "@/server/learner-profile";
import { isAllowedPushEndpoint, reminderPayload } from "@/server/learner-push";
import { cronAuthorized, signDispatch } from "@/server/learner-email";
import { supportMessageInputSchema } from "@/server/learner-support";
import { readLearnerServicesConfig } from "@/lib/env";
import { confirmationTypeSchema } from "@/domain/auth";

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));

describe("file sniffing", () => {
  it("decides the type from magic bytes, not the declaration", () => {
    expect(sniffContentType(bytes("89504e470d0a1a0a0000"))).toBe("image/png");
    expect(sniffContentType(bytes("ffd8ffe0"))).toBe("image/jpeg");
    expect(sniffContentType(bytes("524946460000000057454250"))).toBe(
      "image/webp",
    );
    expect(sniffContentType(bytes("255044462d312e34"))).toBe("application/pdf");
    expect(sniffContentType(new TextEncoder().encode("ok\n\tindent"))).toBe(
      "text/plain",
    );
    expect(sniffContentType(bytes("4749463839610100"))).toBeNull();
    expect(sniffContentType(bytes("66c328"))).toBeNull();
  });
  it("enforces purpose, size and declared-type agreement", () => {
    const png = bytes("89504e470d0a1a0a0000");
    expect(checkPrivateFile("PROFILE_PHOTO", png, "image/png")).toEqual({
      ok: true,
      contentType: "image/png",
    });
    expect(checkPrivateFile("PROFILE_PHOTO", png, "")).toEqual({
      ok: true,
      contentType: "image/png",
    });
    expect(checkPrivateFile("PROFILE_PHOTO", png, "image/jpeg")).toEqual({
      ok: false,
      code: "TYPE_MISMATCH",
    });
    expect(
      checkPrivateFile("PROFILE_PHOTO", bytes("255044462d"), "application/pdf"),
    ).toEqual({ ok: false, code: "UNSUPPORTED_TYPE" });
    expect(
      checkPrivateFile("LAB_EVIDENCE", bytes("255044462d"), "application/pdf"),
    ).toMatchObject({ ok: true });
    expect(
      checkPrivateFile("LAB_EVIDENCE", new Uint8Array(1024 * 1024 + 1), ""),
    ).toEqual({ ok: false, code: "FILE_TOO_LARGE" });
    expect(checkPrivateFile("LAB_EVIDENCE", new Uint8Array(0))).toEqual({
      ok: false,
      code: "EMPTY_FILE",
    });
    expect(sanitizeFileName('../../etc/"passwd".txt')).toBe(
      ".._.._etc__passwd_.txt",
    );
  });
});

describe("profile form mapping", () => {
  it("maps the UI field names and YYYY-MM-DD dates", () => {
    const form = new FormData();
    form.set("firstName", "Ada");
    form.set("lastName", "Lovelace");
    form.set("educationCount", "1");
    form.set("education.0.institution", "Synthetic University");
    form.set("education.0.qualification", "BSc");
    form.set("education.0.startDate", "2019-09-01");
    form.set("education.0.endDate", "2022-06-30");
    form.set("experienceCount", "1");
    form.set("experience.0.organisation", "Synthetic Ltd");
    form.set("experience.0.title", "Analyst");
    form.set("experience.0.startDate", "2022-07-01");
    form.set("experience.0.current", "on");
    form.set("experience.0.endDate", "2023-01-01");
    const input = profileInputFromForm(form);
    const parsed = learnerProfileInputSchema.parse(input);
    expect(parsed.education[0]).toMatchObject({
      startMonth: "2019-09",
      endMonth: "2022-06",
      currentlyStudying: false,
    });
    expect(parsed.employment[0]).toMatchObject({
      employer: "Synthetic Ltd",
      position: "Analyst",
      current: true,
      endMonth: null,
    });
    expect(formFieldName("employment.0.endMonth")).toBe("experience.0.endDate");
    expect(formFieldName("education.0.startMonth")).toBe(
      "education.0.startDate",
    );
    const tooMany = new FormData();
    tooMany.set("educationCount", "999");
    expect(profileInputFromForm(tooMany).education).toHaveLength(21);
  });
});

describe("support, push, dispatch and configuration", () => {
  it("accepts the UI support categories", () => {
    const base = {
      subject: "TEST ONLY",
      message: "TEST ONLY message body",
      requestKey: crypto.randomUUID(),
    };
    expect(
      supportMessageInputSchema.parse({ ...base, category: "COURSE" }).category,
    ).toBe("COURSE_CONTENT");
    expect(
      supportMessageInputSchema.safeParse({ ...base, category: "GOSSIP" })
        .success,
    ).toBe(false);
  });
  it("only allows browser push services and privacy-safe text", () => {
    expect(
      isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc-def-ghi"),
    ).toBe(true);
    expect(
      isAllowedPushEndpoint("https://web.push.apple.com/QWERTY-abcdef"),
    ).toBe(true);
    expect(
      isAllowedPushEndpoint("https://169.254.169.254/latest/meta-data"),
    ).toBe(false);
    expect(
      isAllowedPushEndpoint("https://fcm.googleapis.com.evil.test/x/abcdef"),
    ).toBe(false);
    expect(JSON.parse(reminderPayload("LESSON")).body).toBe(
      "Your class starts in 15 minutes",
    );
    expect(JSON.parse(reminderPayload("ASSESSMENT")).body).toBe(
      "Your scheduled activity starts in 15 minutes",
    );
  });
  it("authorises scheduled dispatch only with the configured secret", () => {
    const secret = "s".repeat(40);
    expect(
      cronAuthorized(
        new Headers({ authorization: `Bearer ${secret}` }),
        secret,
      ),
    ).toBe(true);
    expect(
      cronAuthorized(new Headers({ "x-cron-secret": secret }), secret),
    ).toBe(true);
    expect(
      cronAuthorized(new Headers({ authorization: "Bearer wrong" }), secret),
    ).toBe(false);
    expect(
      cronAuthorized(new Headers({ authorization: `Bearer ${secret}` }), ""),
    ).toBe(false);
    const signed = signDispatch(
      { keyId: "k", secret: Buffer.alloc(32) },
      "CLAIM_EMAIL\n5",
      1000,
    );
    expect(signed).toMatchObject({
      p_key_id: "k",
      p_issued_at: 1000,
      p_expires_at: 1060,
    });
    expect(signed.p_mac).toMatch(/^[0-9a-f]{64}$/);
  });
  it("reports unconfigured services and accepts email_change confirmation", () => {
    const empty = readLearnerServicesConfig({});
    expect(empty.email.configured).toBe(false);
    expect(empty.push.configured).toBe(false);
    expect(empty.seller.configured).toBe(false);
    expect(empty.cronSecret).toBe("");
    expect(readLearnerServicesConfig({ CRON_SECRET: "short" }).cronSecret).toBe(
      "",
    );
    expect(
      readLearnerServicesConfig({
        EMAIL_PROVIDER: "resend",
        RESEND_API_KEY: "re_TESTONLY123",
        EMAIL_FROM: "Ducelio <noreply@example.test>",
      }).email.configured,
    ).toBe(true);
    expect(confirmationTypeSchema.safeParse("email_change").success).toBe(true);
    expect(confirmationTypeSchema.safeParse("invite").success).toBe(false);
  });
});
