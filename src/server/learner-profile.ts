import "server-only";
import { z } from "zod";
import { config } from "@/lib/env";
import { emailSchema } from "@/domain/auth";
import { getAuthenticatedActor, requireStudentPrincipal } from "./identity";
import { AuthenticationRequired } from "@/domain/policy";
import { createSupabase } from "./supabase";

// Learner profile (docs/61 section 4). The database (migration 076) is the
// authority for ownership and bounds; this module mirrors its validation so
// the form can show field-level messages before the RPC refuses.

// Codes the learner-services RPCs raise or return. Anything else is reported
// as SERVICE_UNAVAILABLE; database messages are never shown to a learner.
const KNOWN_CODES = new Set([
  "FORBIDDEN",
  "NOT_FOUND_OR_FORBIDDEN",
  "INVALID_INPUT",
  "IMMUTABLE_HISTORY",
]);
export class LearnerServiceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LearnerServiceError";
  }
}
// The signed-in session client. Identity is resolved by the database from
// the session; no learner id is ever sent. "any" admits a signed-in staff
// member (a lab reviewer); the RPC still decides authority.
export async function callLearnerRpc(
  fn: string,
  args?: Record<string, unknown>,
  audience: "student" | "any" = "student",
) {
  if (audience === "student") await requireStudentPrincipal();
  else if (!(await getAuthenticatedActor())) throw new AuthenticationRequired();
  const { data, error } = await (await createSupabase()).rpc(fn, args);
  if (error) {
    const code = KNOWN_CODES.has(error.message)
      ? error.message
      : "SERVICE_UNAVAILABLE";
    throw new LearnerServiceError(code);
  }
  return data as unknown;
}

// Control characters other than tab and line breaks (prose only).
export function hasControlCharacters(text: string, allowLineBreaks: boolean) {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 0x7f) return true;
    if (c < 0x20 && !(allowLineBreaks && (c === 9 || c === 10 || c === 13)))
      return true;
  }
  return false;
}
const blankToNull = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? null : value;
const singleLine = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine(
      (s) => !hasControlCharacters(s, false),
      "Use a single line of text.",
    );
const optionalLine = (max: number) =>
  z.preprocess(blankToNull, singleLine(1, max).nullable().default(null));
const optionalProse = (max: number) =>
  z.preprocess(
    blankToNull,
    z
      .string()
      .trim()
      .max(max)
      .refine(
        (s) => !hasControlCharacters(s, true),
        "Remove control characters.",
      )
      .nullable()
      .default(null),
  );
export const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use the format YYYY-MM.")
  .refine((m) => m >= "1900-01", "Use a later month.");
const optionalMonth = z.preprocess(
  blankToNull,
  monthSchema.nullable().default(null),
);

export const educationEntrySchema = z
  .strictObject({
    institution: singleLine(1, 150),
    qualification: singleLine(1, 150),
    fieldOfStudy: optionalLine(150),
    startMonth: monthSchema,
    endMonth: optionalMonth,
    currentlyStudying: z.boolean(),
    grade: optionalLine(50),
    description: optionalProse(2000),
  })
  .superRefine((entry, ctx) => {
    if (entry.currentlyStudying && entry.endMonth)
      ctx.addIssue({
        code: "custom",
        path: ["endMonth"],
        message: "Leave the end month empty while you are still studying.",
      });
    if (!entry.currentlyStudying && !entry.endMonth)
      ctx.addIssue({
        code: "custom",
        path: ["endMonth"],
        message: "Add an end month, or mark this as current.",
      });
    if (entry.endMonth && entry.endMonth < entry.startMonth)
      ctx.addIssue({
        code: "custom",
        path: ["endMonth"],
        message: "The end month cannot be before the start month.",
      });
  });

export const employmentEntrySchema = z
  .strictObject({
    employer: singleLine(1, 150),
    position: singleLine(1, 150),
    startMonth: monthSchema,
    endMonth: optionalMonth,
    current: z.boolean(),
    description: optionalProse(2000),
  })
  .superRefine((entry, ctx) => {
    if (entry.current && entry.endMonth)
      ctx.addIssue({
        code: "custom",
        path: ["endMonth"],
        message: "Leave the end month empty for a current role.",
      });
    if (!entry.current && !entry.endMonth)
      ctx.addIssue({
        code: "custom",
        path: ["endMonth"],
        message: "Add an end month, or mark this as your current role.",
      });
    if (entry.endMonth && entry.endMonth < entry.startMonth)
      ctx.addIssue({
        code: "custom",
        path: ["endMonth"],
        message: "The end month cannot be before the start month.",
      });
  });

export const learnerProfileInputSchema = z
  .strictObject({
    firstName: singleLine(1, 60),
    lastName: singleLine(1, 60),
    education: z.array(educationEntrySchema).max(20),
    employment: z.array(employmentEntrySchema).max(20),
  })
  .refine((p) => p.firstName.length + p.lastName.length <= 99, {
    path: ["lastName"],
    message: "Your full name must be at most 100 characters.",
  });
export type LearnerProfileInput = z.input<typeof learnerProfileInputSchema>;

export const learnerProfileSchema = z.object({
  displayName: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  studentNumber: z.string().nullable(),
  photo: z
    .object({
      fileId: z.uuid(),
      contentType: z.string(),
      sizeBytes: z.number().int(),
      uploadedAt: z.string(),
    })
    .nullable(),
  education: z.array(
    z.object({
      institution: z.string(),
      qualification: z.string(),
      fieldOfStudy: z.string().nullable(),
      startMonth: z.string(),
      endMonth: z.string().nullable(),
      currentlyStudying: z.boolean(),
      grade: z.string().nullable(),
      description: z.string().nullable(),
    }),
  ),
  employment: z.array(
    z.object({
      employer: z.string(),
      position: z.string(),
      startMonth: z.string(),
      endMonth: z.string().nullable(),
      current: z.boolean(),
      description: z.string().nullable(),
    }),
  ),
  updatedAt: z.string().nullable(),
});
type RawProfile = z.infer<typeof learnerProfileSchema>;
// UI projection (docs/61 Lane A contract): photoUrl is the authenticated
// file route; dates are first-of-month ISO dates (YYYY-MM-01); `experience`
// is the employment list under the UI's field names. The raw RPC fields
// (startMonth, employment, ...) are kept alongside for compatibility.
const monthToDate = (m: string | null) => (m ? `${m}-01` : null);
export function toProfileView(p: RawProfile) {
  return {
    ...p,
    photoUrl: p.photo ? `/api/learner/files/${p.photo.fileId}` : null,
    education: p.education.map((e) => ({
      ...e,
      startDate: monthToDate(e.startMonth)!,
      endDate: monthToDate(e.endMonth),
      current: e.currentlyStudying,
    })),
    experience: p.employment.map((e) => ({
      organisation: e.employer,
      title: e.position,
      startDate: monthToDate(e.startMonth)!,
      endDate: monthToDate(e.endMonth),
      current: e.current,
      description: e.description,
    })),
  };
}
export type LearnerProfile = ReturnType<typeof toProfileView>;

export async function getMyLearnerProfile(): Promise<LearnerProfile> {
  return toProfileView(
    learnerProfileSchema.parse(await callLearnerRpc("get_my_learner_profile")),
  );
}

// The profile form (Lane A): firstName, lastName, educationCount,
// education.N.{institution,qualification,fieldOfStudy,startDate,endDate,current},
// experienceCount, experience.N.{organisation,title,startDate,endDate,current}.
// Dates are YYYY-MM-DD (stored by month); endDate is omitted while current.
// Returns the input for saveMyLearnerProfile; validation happens there.
export function profileInputFromForm(form: FormData) {
  const text = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v : "";
  };
  const count = (name: string) => {
    const n = Number(text(name) || "0");
    return Number.isInteger(n) && n >= 0 ? Math.min(n, 21) : 21;
  };
  const toMonth = (value: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.slice(0, 7) : value;
  const flag = (name: string) => ["on", "true", "1"].includes(text(name));
  const education = Array.from({ length: count("educationCount") }, (_, i) => {
    const f = (k: string) => text(`education.${i}.${k}`);
    const current = flag(`education.${i}.current`);
    return {
      institution: f("institution"),
      qualification: f("qualification"),
      fieldOfStudy: f("fieldOfStudy"),
      startMonth: toMonth(f("startDate")),
      endMonth: current ? null : toMonth(f("endDate")),
      currentlyStudying: current,
      grade: f("grade"),
      description: f("description"),
    };
  });
  const employment = Array.from(
    { length: count("experienceCount") },
    (_, i) => {
      const f = (k: string) => text(`experience.${i}.${k}`);
      const current = flag(`experience.${i}.current`);
      return {
        employer: f("organisation"),
        position: f("title"),
        startMonth: toMonth(f("startDate")),
        endMonth: current ? null : toMonth(f("endDate")),
        current,
        description: f("description"),
      };
    },
  );
  return {
    firstName: text("firstName"),
    lastName: text("lastName"),
    education,
    employment,
  };
}

// Maps validation paths to the form's own field names, e.g.
// "employment.0.endMonth" -> "experience.0.endDate".
export function formFieldName(path: string) {
  return path
    .replace(/^employment\./, "experience.")
    .replace(/\.employer$/, ".organisation")
    .replace(/\.position$/, ".title")
    .replace(/\.startMonth$/, ".startDate")
    .replace(/\.endMonth$/, ".endDate")
    .replace(/\.(currentlyStudying)$/, ".current");
}

export type SaveProfileResult =
  | { ok: true; profile: LearnerProfile }
  | { ok: false; fieldErrors: Record<string, string> };

// Field paths use dots, e.g. "education.0.endMonth".
export async function saveMyLearnerProfile(
  input: unknown,
): Promise<SaveProfileResult> {
  const parsed = learnerProfileInputSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "form";
      fieldErrors[key] ??= issue.message;
    }
    return { ok: false, fieldErrors };
  }
  const p = parsed.data;
  try {
    const data = await callLearnerRpc("save_my_learner_profile", {
      p_first_name: p.firstName,
      p_last_name: p.lastName,
      p_education: p.education,
      p_employment: p.employment,
    });
    return {
      ok: true,
      profile: toProfileView(learnerProfileSchema.parse(data)),
    };
  } catch (error) {
    if (error instanceof LearnerServiceError && error.code === "INVALID_INPUT")
      return {
        ok: false,
        fieldErrors: { form: "Some details could not be saved. Check them." },
      };
    throw error;
  }
}

// Email changes go only through Supabase Auth's verified email-change flow:
// nothing changes until the confirmation link (both links, when "secure
// email change" is enabled) is followed through /auth/confirm. Identity is
// keyed by the auth user id, never by the address.
export async function requestMyEmailChange(
  email: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) return { ok: false, error: "Enter a valid email." };
  await requireStudentPrincipal();
  const client = await createSupabase();
  const { error } = await client.auth.updateUser(
    { email: parsed.data },
    {
      emailRedirectTo: `${config().appUrl}/auth/confirm?next=/student/profile`,
    },
  );
  if (error)
    return {
      ok: false,
      error: "The email change could not be started. Try again later.",
    };
  return { ok: true };
}
