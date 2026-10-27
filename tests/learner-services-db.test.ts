import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "./db-helper";
import {
  approvedTestPackage,
  as,
  people,
  rpc,
  seedPeople,
  type Person,
  type Query,
} from "./academy-fixture";
import { validateAcademyCoursePackage } from "@/domain/academy-course-package";
import {
  dispatchLearnerEmail,
  type EmailAdapter,
  type LearnerRpc,
  type OutgoingEmail,
} from "@/server/learner-email";
import {
  dispatchActivityReminders,
  type PushSender,
} from "@/server/learner-push";

// Migration 076 learner services on PGlite under hosted Supabase default
// privileges: deny-by-default grants, owner and organisation-reviewer
// boundaries, file validation, the outbox and push dispatchers (with fake
// providers), support rate limiting, certificates and receipts.
let db: PGlite;
let q: Query;
let orgA: string;
let enrolA: string;
const keyId = randomUUID();
const key = randomBytes(32);
const controller = { keyId, secret: key };
const reason = "TEST ONLY learner services acceptance";
const {
  admin,
  learnerA,
  learnerB,
  learnerC,
  instructor: reviewerA,
  registrar: ownerB,
} = people;

const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  Buffer.from("0000000d49484452000000010000000108060000001f15c489", "hex"),
]);
const JPEG = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1");
const PDF = Buffer.from("%PDF-1.4\n%TEST ONLY synthetic\n", "latin1");
const b64 = (b: Buffer) => b.toString("base64");

const anonRpc: LearnerRpc = async (fn, args) => {
  const names = Object.keys(args);
  const rows = await as<{ r: unknown }>(
    q,
    null,
    `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(",")}) as r`,
    names.map((n) => args[n]),
  );
  return rows[0].r;
};
const one = async <T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
) => (await q(sql, params)).rows[0] as T;
const upload = (
  person: Person,
  purpose: string,
  enrolment: string | null,
  type: string,
  bytes: Buffer,
  name = "evidence file.bin",
) =>
  rpc<{ ok: boolean; code?: string; fileId: string }>(
    q,
    person,
    "upload_my_private_file",
    [purpose, enrolment, name, type, b64(bytes)],
  );

beforeAll(async () => {
  db = await testDatabase({ supabaseDefaultPrivileges: true });
  q = (sql, params) =>
    db.query(sql, params) as Promise<{ rows: Record<string, unknown>[] }>;
  await seedPeople(q);
  await q(
    "select commercial_v1_commerce_private.install_controller_key($1,$2::bytea)",
    [keyId, key],
  );
  await q(
    "insert into public.role_grants(user_id,role) values($1,'PLATFORM_ADMIN')",
    [admin.id],
  );
  orgA = await rpc(q, admin, "create_course_organisation", [
    "services-tenant-one",
    "Synthetic Tenant One",
    reviewerA.id,
    reason,
  ]);
  await rpc(q, admin, "create_course_organisation", [
    "services-tenant-two",
    "Synthetic Tenant Two",
    ownerB.id,
    reason,
  ]);
  const raw = approvedTestPackage("learner-services-source");
  raw.course.demoContent = true;
  const pkg = await rpc<string>(
    q,
    reviewerA,
    "upload_organisation_course_package",
    [orgA, JSON.stringify(raw), reason],
  );
  const stored = await rpc(q, reviewerA, "get_academy_course_package_content", [
    pkg,
  ]);
  const checked = validateAcademyCoursePackage(stored);
  if (!checked.valid) throw new Error(JSON.stringify(checked.errors));
  await rpc(q, reviewerA, "mark_academy_course_package_validated", [
    pkg,
    JSON.stringify(checked.review),
    reason,
  ]);
  await rpc<{ courseId: string }>(q, reviewerA, "publish_unified_course", [
    pkg,
    "learner-services-course",
    "GBP",
    10000,
    null,
    reason,
  ]);
  await rpc(q, reviewerA, "create_organisation_course_coupon", [
    orgA,
    "SERVICES100",
    100,
    new Date(Date.now() + 86400000).toISOString(),
    5,
    null,
    reason,
  ]);
  const free = await rpc<{ ok: boolean; enrolmentId: string }>(
    q,
    learnerA,
    "create_unified_course_order",
    ["learner-services-course", "SERVICES100"],
  );
  enrolA = free.enrolmentId;
  const confirmed = await rpc<{ ok: boolean }>(
    q,
    learnerA,
    "confirm_my_academy_schedule",
    [
      enrolA,
      "STANDARD_6W",
      new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      [1, 2, 3, 4, 5, 6],
      "09:00",
      "Europe/London",
      randomUUID(),
    ],
  );
  if (!confirmed.ok) throw new Error(JSON.stringify(confirmed));
}, 300000);
afterAll(async () => {
  await db?.close();
});

const LEARNER_TABLES = [
  "learner_private_files",
  "learner_profiles",
  "learner_profile_education",
  "learner_profile_employment",
  "learner_lab_evidence",
  "learner_lab_evidence_files",
  "learner_email_outbox",
  "learner_push_subscriptions",
  "learner_activity_reminders",
  "learner_support_messages",
  "learner_certificates",
  "learner_payment_receipts",
];

describe("deny-by-default privileges", () => {
  it("grants no client table access and keeps learner_private unreachable", async () => {
    const leaked = await q(
      `select c.relname||' '||r f from pg_class c join pg_namespace n on n.oid=c.relnamespace
       cross join unnest(array['anon','authenticated','service_role']) r
       where n.nspname='public' and c.relname = any($1)
         and (has_table_privilege(r,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
           or has_any_column_privilege(r,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))`,
      [LEARNER_TABLES],
    );
    expect(leaked.rows).toEqual([]);
    const rls = await q(
      "select relname from pg_class where relname = any($1) and not relrowsecurity",
      [LEARNER_TABLES],
    );
    expect(rls.rows).toEqual([]);
    const privateFns = await q(
      `select p.proname||' '||r f from pg_proc p cross join unnest(array['anon','authenticated','service_role']) r
       where p.pronamespace='learner_private'::regnamespace and has_function_privilege(r,p.oid,'EXECUTE')`,
    );
    expect(privateFns.rows).toEqual([]);
    for (const table of ["learner_profiles", "learner_email_outbox"]) {
      await expect(
        as(q, learnerA, `select * from public.${table}`),
      ).rejects.toThrow(/permission denied/);
      await expect(
        as(q, null, `select * from public.${table}`),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("limits anon to verification and the HMAC dispatcher surface", async () => {
    const anon = await q(
      `select p.proname f from pg_proc p where p.pronamespace='public'::regnamespace
         and p.proname like any(array['%learner%','%certificate%','%receipt%','%push%','%support_message%','%private_file%','%lab_evidence%','%reminder%'])
         and has_function_privilege('anon',p.oid,'EXECUTE') order by 1`,
    );
    expect(anon.rows.map((r) => r.f)).toEqual([
      "claim_learner_email_batch",
      "claim_learner_push_batch",
      "complete_learner_email",
      "complete_learner_push",
      "verify_certificate",
    ]);
    await expect(rpc(q, null, "get_my_learner_profile")).rejects.toThrow();
    await expect(rpc(q, null, "get_my_certificates")).rejects.toThrow();
    // A forged dispatcher claim is refused without revealing anything.
    expect(
      await anonRpc("claim_learner_email_batch", {
        p_limit: 5,
        p_key_id: keyId,
        p_issued_at: Math.floor(Date.now() / 1000),
        p_expires_at: Math.floor(Date.now() / 1000) + 60,
        p_mac: "0".repeat(64),
      }),
    ).toEqual({ ok: false, code: "UNTRUSTED_CLAIM" });
  });
});

describe("learner profile", () => {
  const education = [
    {
      institution: "Synthetic University",
      qualification: "BSc Computing",
      fieldOfStudy: "Networks",
      startMonth: "2019-09",
      endMonth: "2022-06",
      currentlyStudying: false,
      grade: "First",
      description: "TEST ONLY entry\nwith a second line",
    },
    {
      institution: "Synthetic College",
      qualification: "MSc Security",
      startMonth: "2024-09",
      currentlyStudying: true,
    },
  ];
  const employment = [
    {
      employer: "Synthetic Ltd",
      position: "Analyst",
      startMonth: "2022-07",
      current: true,
      description: null,
    },
  ];
  it("saves validated details, keeps entry order and updates the display name", async () => {
    const empty = await rpc<{ firstName: null; education: unknown[] }>(
      q,
      learnerA,
      "get_my_learner_profile",
    );
    expect(empty).toMatchObject({
      firstName: null,
      education: [],
      email: learnerA.email,
    });
    const saved = await rpc<Record<string, unknown>>(
      q,
      learnerA,
      "save_my_learner_profile",
      [
        "  Ada ",
        "Lovelace",
        JSON.stringify(education),
        JSON.stringify(employment),
      ],
    );
    expect(saved).toMatchObject({
      firstName: "Ada",
      lastName: "Lovelace",
      displayName: "Ada Lovelace",
      education: [
        { institution: "Synthetic University", endMonth: "2022-06" },
        {
          institution: "Synthetic College",
          endMonth: null,
          currentlyStudying: true,
        },
      ],
      employment: [
        { employer: "Synthetic Ltd", position: "Analyst", current: true },
      ],
    });
    expect(
      (
        await one("select display_name from public.app_users where id=$1", [
          learnerA.id,
        ])
      ).display_name,
    ).toBe("Ada Lovelace");
    // Another learner sees only their own (empty) profile.
    expect(await rpc(q, learnerB, "get_my_learner_profile")).toMatchObject({
      firstName: null,
      education: [],
      email: learnerB.email,
    });
  });

  it("refuses invalid or oversized details and non-learners", async () => {
    const bad: [string, string, unknown[], unknown[]][] = [
      ["", "Lovelace", [], []],
      ["Ada", "x".repeat(61), [], []],
      ["Ada\u0007", "Lovelace", [], []],
      ["Ada", "Lovelace", [{ ...education[0], endMonth: "2018-01" }], []],
      ["Ada", "Lovelace", [{ ...education[1], endMonth: "2025-01" }], []],
      ["Ada", "Lovelace", [{ ...education[0], startMonth: "2019-13" }], []],
      ["Ada", "Lovelace", [{ ...education[0], currentlyStudying: "yes" }], []],
      ["Ada", "Lovelace", Array(21).fill(education[1]), []],
      ["Ada", "Lovelace", [], [{ ...employment[0], current: false }]],
      [
        "Ada",
        "Lovelace",
        [],
        [{ ...employment[0], employer: "y".repeat(151) }],
      ],
    ];
    for (const [first, last, edu, emp] of bad)
      await expect(
        rpc(q, learnerA, "save_my_learner_profile", [
          first,
          last,
          JSON.stringify(edu),
          JSON.stringify(emp),
        ]),
      ).rejects.toThrow("INVALID_INPUT");
    // The refused saves changed nothing.
    expect(
      (
        await rpc<{ education: unknown[] }>(
          q,
          learnerA,
          "get_my_learner_profile",
        )
      ).education,
    ).toHaveLength(2);
    await expect(rpc(q, reviewerA, "get_my_learner_profile")).rejects.toThrow(
      "FORBIDDEN",
    );
  });
});

describe("private files", () => {
  it("validates size, type and magic bytes in the RPC and in table constraints", async () => {
    expect(
      await upload(learnerA, "PROFILE_PHOTO", null, "image/jpeg", PNG),
    ).toEqual({
      ok: false,
      code: "TYPE_MISMATCH",
    });
    expect(
      await upload(learnerA, "PROFILE_PHOTO", null, "image/png", GIF),
    ).toEqual({
      ok: false,
      code: "TYPE_MISMATCH",
    });
    expect(
      await upload(learnerA, "PROFILE_PHOTO", null, "application/pdf", PDF),
    ).toEqual({ ok: false, code: "UNSUPPORTED_TYPE" });
    expect(
      await upload(
        learnerA,
        "PROFILE_PHOTO",
        null,
        "image/png",
        Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]),
      ),
    ).toEqual({ ok: false, code: "FILE_TOO_LARGE" });
    expect(
      await upload(
        learnerA,
        "PROFILE_PHOTO",
        null,
        "image/png",
        Buffer.alloc(0),
      ),
    ).toEqual({ ok: false, code: "EMPTY_FILE" });
    expect(
      await upload(
        learnerA,
        "LAB_EVIDENCE",
        enrolA,
        "text/plain",
        Buffer.from([0x66, 0xc3, 0x28]),
      ),
    ).toEqual({ ok: false, code: "TYPE_MISMATCH" });
    // The table refuses a forged row even from the database owner.
    await expect(
      q(
        `insert into public.learner_private_files(owner_id,purpose,file_name,content_type,size_bytes,sha256,bytes)
         values($1,'PROFILE_PHOTO','x.png','image/png',$2,sha256($3::bytea),$3::bytea)`,
        [learnerA.id, GIF.length, GIF],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("stores, replaces and deletes an owner-only profile photo", async () => {
    const first = await upload(
      learnerA,
      "PROFILE_PHOTO",
      null,
      "image/png",
      PNG,
      "me<script>.png",
    );
    expect(first.ok).toBe(true);
    const read = await rpc<{
      contentType: string;
      contentBase64: string;
      fileName: string;
    }>(q, learnerA, "read_private_file", [first.fileId]);
    expect(read.contentType).toBe("image/png");
    expect(read.fileName).toBe("me_script_.png");
    expect(Buffer.from(read.contentBase64, "base64").equals(PNG)).toBe(true);
    for (const other of [learnerB, reviewerA, ownerB])
      await expect(
        rpc(q, other, "read_private_file", [first.fileId]),
      ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
    await expect(
      rpc(q, null, "read_private_file", [first.fileId]),
    ).rejects.toThrow();
    const second = await upload(
      learnerA,
      "PROFILE_PHOTO",
      null,
      "image/jpeg",
      JPEG,
    );
    expect(second.ok).toBe(true);
    expect(
      (
        await one(
          "select count(*)::int n from public.learner_private_files where id=$1",
          [first.fileId],
        )
      ).n,
    ).toBe(0);
    expect(
      (
        await rpc<{ photo: { fileId: string } }>(
          q,
          learnerA,
          "get_my_learner_profile",
        )
      ).photo.fileId,
    ).toBe(second.fileId);
    await expect(
      rpc(q, learnerB, "delete_my_private_file", [second.fileId]),
    ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
    expect(
      await rpc(q, learnerA, "delete_my_private_file", [second.fileId]),
    ).toEqual({
      ok: true,
    });
    expect(
      (await rpc<{ photo: unknown }>(q, learnerA, "get_my_learner_profile"))
        .photo,
    ).toBeNull();
  });
});

describe("lab evidence", () => {
  let labRef: string;
  let otherLab: string;
  it("attaches up to five owner files with formatted code, idempotently", async () => {
    const labs = await q(
      `select distinct i.ref from public.academy_schedule_items i join public.academy_schedules s on s.id=i.schedule_id
       where s.enrolment_id=$1 and s.superseded_at is null and i.kind='LAB' order by 1 limit 2`,
      [enrolA],
    );
    [labRef, otherLab] = labs.rows.map((r) => r.ref as string);
    const png = await upload(
      learnerA,
      "LAB_EVIDENCE",
      enrolA,
      "image/png",
      PNG,
    );
    const text = await upload(
      learnerA,
      "LAB_EVIDENCE",
      enrolA,
      "text/plain",
      Buffer.from("TEST ONLY findings\n\tindented\n", "utf8"),
    );
    expect(png.ok && text.ok).toBe(true);
    const code = "def check():\n    return True\n\n# TEST ONLY\n";
    const key = randomUUID();
    expect(
      await rpc(q, learnerA, "submit_my_lab_evidence", [
        enrolA,
        labRef,
        [png.fileId, text.fileId],
        code,
        key,
      ]),
    ).toEqual({ ok: false, code: "LAB_NOT_OPEN" });
    await q(
      "alter table public.academy_schedule_items disable trigger guard_history",
    );
    await q(
      `update public.academy_schedule_items set starts_at=now()-interval '3 hours', ends_at=now()-interval '2 hours'
       where enrolment_id=$1 and kind='LAB' and ref = any($2)`,
      [enrolA, [labRef, otherLab]],
    );
    await q(
      "alter table public.academy_schedule_items enable trigger guard_history",
    );
    // Another learner can neither use these files nor this enrolment.
    await expect(
      rpc(q, learnerB, "submit_my_lab_evidence", [
        enrolA,
        labRef,
        [png.fileId],
        null,
        randomUUID(),
      ]),
    ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
    await expect(
      upload(learnerB, "LAB_EVIDENCE", enrolA, "image/png", PNG),
    ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
    const submitted = await rpc<{
      ok: boolean;
      replayed: boolean;
      evidence: { codeText: string; files: { fileId: string }[] };
    }>(q, learnerA, "submit_my_lab_evidence", [
      enrolA,
      labRef,
      [png.fileId, text.fileId],
      code,
      key,
    ]);
    expect(submitted).toMatchObject({ ok: true, replayed: false });
    expect(submitted.evidence.codeText).toBe(code);
    expect(submitted.evidence.files.map((f) => f.fileId)).toEqual([
      png.fileId,
      text.fileId,
    ]);
    // The same submit writes the governed practical submission that
    // progression, review and marking read, with the code exactly as written.
    const governed = await q(
      "select body, request_key from public.academy_lab_submissions where enrolment_id=$1 and lab_ref=$2",
      [enrolA, labRef],
    );
    expect(governed.rows).toEqual([{ body: code, request_key: key }]);
    expect(
      await rpc(q, learnerA, "submit_my_lab_evidence", [
        enrolA,
        labRef,
        [png.fileId],
        code,
        key,
      ]),
    ).toMatchObject({ ok: true, replayed: true });
    expect(
      await rpc(q, learnerA, "submit_my_lab_evidence", [
        enrolA,
        labRef,
        [],
        code,
        randomUUID(),
      ]),
    ).toEqual({ ok: false, code: "EVIDENCE_EXISTS" });
    // Attached evidence is immutable and its files cannot be deleted.
    expect(
      await rpc(q, learnerA, "delete_my_private_file", [png.fileId]),
    ).toEqual({
      ok: false,
      code: "FILE_ATTACHED",
    });
    await expect(
      q(
        "update public.learner_lab_evidence set code_text='changed' where enrolment_id=$1",
        [enrolA],
      ),
    ).rejects.toThrow("IMMUTABLE_HISTORY");
    // Six files, reused files and empty evidence are refused.
    const six: string[] = [];
    for (let i = 0; i < 6; i++)
      six.push(
        (await upload(learnerA, "LAB_EVIDENCE", enrolA, "application/pdf", PDF))
          .fileId,
      );
    expect(
      await rpc(q, learnerA, "submit_my_lab_evidence", [
        enrolA,
        otherLab,
        six,
        null,
        randomUUID(),
      ]),
    ).toEqual({ ok: false, code: "TOO_MANY_FILES" });
    expect(
      await rpc(q, learnerA, "submit_my_lab_evidence", [
        enrolA,
        otherLab,
        [png.fileId],
        null,
        randomUUID(),
      ]),
    ).toEqual({ ok: false, code: "INVALID_FILE" });
    expect(
      await rpc(q, learnerA, "submit_my_lab_evidence", [
        enrolA,
        otherLab,
        [],
        "   \n",
        randomUUID(),
      ]),
    ).toEqual({ ok: false, code: "EMPTY_EVIDENCE" });
    for (const id of six.slice(1))
      await rpc(q, learnerA, "delete_my_private_file", [id]);
    // A practical whose availability window has closed refuses evidence.
    const shift = async (interval: string) => {
      await q(
        "alter table public.academy_schedule_items disable trigger guard_history",
      );
      await q(
        `update public.academy_schedule_items set starts_at=now()-$3::interval, ends_at=now()-$3::interval+interval '1 hour'
         where enrolment_id=$1 and kind='LAB' and ref=$2`,
        [enrolA, otherLab, interval],
      );
      await q(
        "alter table public.academy_schedule_items enable trigger guard_history",
      );
    };
    await shift("2 days");
    expect(
      await rpc(q, learnerA, "submit_my_lab_evidence", [
        enrolA,
        otherLab,
        [six[0]],
        null,
        randomUUID(),
      ]),
    ).toEqual({ ok: false, code: "WINDOW_CLOSED" });
    // Files-only evidence records the file names as the governed body.
    await shift("3 hours");
    expect(
      await rpc(q, learnerA, "submit_my_lab_evidence", [
        enrolA,
        otherLab,
        [six[0]],
        null,
        randomUUID(),
      ]),
    ).toMatchObject({ ok: true, replayed: false });
    const filesOnly = await q(
      "select body from public.academy_lab_submissions where enrolment_id=$1 and lab_ref=$2",
      [enrolA, otherLab],
    );
    expect(filesOnly.rows[0].body).toMatch(/^Practical evidence files: \S/);
  });

  it("is readable by the owner and the course organisation's reviewer only", async () => {
    const own = await rpc<{ evidence: { files: { fileId: string }[] } }>(
      q,
      learnerA,
      "get_my_lab_evidence",
      [enrolA, labRef],
    );
    const fileId = own.evidence.files[0].fileId;
    const reviewed = await rpc<{ evidence: { evidenceId: string } }>(
      q,
      reviewerA,
      "get_lab_evidence_for_review",
      [enrolA, labRef],
    );
    expect(reviewed.evidence.evidenceId).toBeTruthy();
    expect(
      (
        await rpc<{ contentType: string }>(q, reviewerA, "read_private_file", [
          fileId,
        ])
      ).contentType,
    ).toBe("image/png");
    // Another organisation's owner, another learner and the learner acting
    // as their own reviewer are all refused.
    for (const other of [ownerB, learnerB, learnerC])
      await expect(
        rpc(q, other, "get_lab_evidence_for_review", [enrolA, labRef]),
      ).rejects.toThrow("FORBIDDEN");
    await expect(
      rpc(q, learnerA, "get_lab_evidence_for_review", [enrolA, labRef]),
    ).rejects.toThrow("FORBIDDEN");
    for (const other of [ownerB, learnerB])
      await expect(
        rpc(q, other, "read_private_file", [fileId]),
      ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
    await expect(
      rpc(q, learnerB, "get_my_lab_evidence", [enrolA, labRef]),
    ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
    // An unattached upload stays owner-only even for the reviewer.
    const loose = await upload(
      learnerA,
      "LAB_EVIDENCE",
      enrolA,
      "application/pdf",
      PDF,
    );
    await expect(
      rpc(q, reviewerA, "read_private_file", [loose.fileId]),
    ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
    // The owner can list unattached uploads (metadata only) to resume or
    // clean up an abandoned form; attached files and other learners are out.
    const unattached = await rpc<{ fileId: string; bytes?: unknown }[]>(
      q,
      learnerA,
      "list_my_unattached_lab_files",
      [enrolA],
    );
    expect(unattached.map((f) => f.fileId)).toEqual([loose.fileId]);
    expect(unattached[0].bytes).toBeUndefined();
    expect(unattached.map((f) => f.fileId)).not.toContain(fileId);
    await expect(
      rpc(q, learnerB, "list_my_unattached_lab_files", [enrolA]),
    ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
    await rpc(q, learnerA, "delete_my_private_file", [loose.fileId]);
    expect(
      await rpc(q, learnerA, "list_my_unattached_lab_files", [enrolA]),
    ).toEqual([]);
  });
});

describe("support messages and the email outbox", () => {
  const submit = (
    person: Person,
    key: string,
    subject = "TEST ONLY question",
  ) =>
    rpc<{
      ok: boolean;
      code?: string;
      messageId: string;
      delivery: string;
      replayed: boolean;
    }>(q, person, "submit_my_support_message", [
      "TECHNICAL",
      subject,
      "TEST ONLY synthetic support message body.",
      enrolA,
      "lesson-1",
      key,
    ]);
  it("queues one email per message with the verified reply-to and rate limits", async () => {
    const key = randomUUID();
    const first = await submit(learnerA, key);
    expect(first).toMatchObject({
      ok: true,
      delivery: "QUEUED",
      replayed: false,
    });
    const replay = await submit(learnerA, key);
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      messageId: first.messageId,
    });
    const outbox = await q(
      "select recipient,reply_to,status,kind,subject from public.learner_email_outbox where idempotency_key=$1",
      [`SUPPORT:${first.messageId}`],
    );
    expect(outbox.rows).toEqual([
      {
        recipient: "support@ducelio.com",
        reply_to: learnerA.email,
        status: "QUEUED",
        kind: "SUPPORT_MESSAGE",
        subject: "[Ducelio support] TEST ONLY question",
      },
    ]);
    // Another learner's enrolment and invalid input are refused.
    expect(
      await rpc(q, learnerB, "submit_my_support_message", [
        "TECHNICAL",
        "TEST ONLY",
        "TEST ONLY synthetic support message body.",
        enrolA,
        null,
        randomUUID(),
      ]),
    ).toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(
      await rpc(q, learnerA, "submit_my_support_message", [
        "GOSSIP",
        "TEST ONLY",
        "TEST ONLY synthetic support message body.",
        null,
        null,
        randomUUID(),
      ]),
    ).toEqual({ ok: false, code: "INVALID_INPUT" });
    for (let i = 0; i < 4; i++)
      expect((await submit(learnerA, randomUUID(), `TEST ONLY ${i}`)).ok).toBe(
        true,
      );
    expect(await submit(learnerA, randomUUID())).toMatchObject({
      ok: false,
      code: "RATE_LIMITED",
    });
    expect(
      (
        await one(
          "select count(*)::int n from public.learner_support_messages where sender_id=$1",
          [learnerA.id],
        )
      ).n,
    ).toBe(5);
    expect(
      (await rpc<unknown[]>(q, learnerA, "list_my_support_messages")).length,
    ).toBe(5);
    expect(await rpc(q, learnerB, "list_my_support_messages")).toEqual([]);
  });

  it("keeps mail QUEUED without a provider and records SENT only with an acknowledgement", async () => {
    const queued = async () =>
      (
        await one<{ n: number }>(
          "select count(*)::int n from public.learner_email_outbox where status='QUEUED'",
        )
      ).n;
    const before = await queued();
    expect(before).toBe(5);
    expect(
      await dispatchLearnerEmail({
        rpc: anonRpc,
        controller,
        adapter: null,
        appUrl: "https://example.test",
      }),
    ).toMatchObject({ configured: false, claimed: 0 });
    expect(await queued()).toBe(before);

    const sent: OutgoingEmail[] = [];
    let failNext = true;
    const fake: EmailAdapter = {
      name: "fake",
      async send(email) {
        if (failNext) throw new Error("provider down");
        sent.push(email);
        return { providerMessageId: `fake-${sent.length}` };
      },
    };
    const failedRun = await dispatchLearnerEmail({
      rpc: anonRpc,
      controller,
      adapter: fake,
      appUrl: "https://example.test",
      limit: 2,
    });
    expect(failedRun).toMatchObject({
      configured: true,
      claimed: 2,
      sent: 0,
      retrying: 2,
    });
    const retried = await q(
      "select attempts,status,last_error,next_attempt_at>now() later from public.learner_email_outbox where attempts>0",
    );
    expect(retried.rows).toEqual([
      {
        attempts: 1,
        status: "QUEUED",
        last_error: "DELIVERY_FAILED",
        later: true,
      },
      {
        attempts: 1,
        status: "QUEUED",
        last_error: "DELIVERY_FAILED",
        later: true,
      },
    ]);
    failNext = false;
    await q(
      "update public.learner_email_outbox set next_attempt_at=now()-interval '1 second'",
    );
    const okRun = await dispatchLearnerEmail({
      rpc: anonRpc,
      controller,
      adapter: fake,
      appUrl: "https://example.test",
      limit: 50,
    });
    expect(okRun).toMatchObject({ claimed: 5, sent: 5 });
    expect(
      sent.every(
        (e) => e.to === "support@ducelio.com" && e.replyTo === learnerA.email,
      ),
    ).toBe(true);
    const states = await q(
      "select status,provider_message_id is not null acked,sent_at is not null stamped from public.learner_email_outbox",
    );
    expect(
      states.rows.every((r) => r.status === "SENT" && r.acked && r.stamped),
    ).toBe(true);
    // Nothing left to claim; an unacknowledged SENT is refused.
    expect(
      await dispatchLearnerEmail({
        rpc: anonRpc,
        controller,
        adapter: fake,
        appUrl: "https://example.test",
      }),
    ).toMatchObject({ claimed: 0 });
    const msg = await one<{ id: string }>(
      "select id from public.learner_email_outbox limit 1",
    );
    expect(
      await anonRpc("complete_learner_email", {
        p_message_id: msg.id,
        p_attempt: 2,
        p_outcome: "SENT",
        p_provider_message_id: null,
        p_error: null,
        ...sign(["COMPLETE_EMAIL", msg.id, "2", "SENT", "", ""].join("\n")),
      }),
    ).toMatchObject({ ok: true, status: "SENT", replay: true });
  });

  it("fails a message after five bounded attempts", async () => {
    await q(
      `insert into public.learner_email_outbox(idempotency_key,kind,recipient,subject,body_text)
       values('TEST_ONLY:exhaust','SUPPORT_MESSAGE','support@ducelio.com','TEST ONLY','TEST ONLY body')`,
    );
    const broken: EmailAdapter = {
      name: "broken",
      async send() {
        throw new Error("down");
      },
    };
    for (let i = 0; i < 5; i++) {
      await q(
        "update public.learner_email_outbox set next_attempt_at=now()-interval '1 second' where idempotency_key='TEST_ONLY:exhaust'",
      );
      await dispatchLearnerEmail({
        rpc: anonRpc,
        controller,
        adapter: broken,
        appUrl: "https://example.test",
      });
    }
    expect(
      await one(
        "select status,attempts from public.learner_email_outbox where idempotency_key='TEST_ONLY:exhaust'",
      ),
    ).toEqual({ status: "FAILED", attempts: 5 });
  });
});

function sign(canonical: string) {
  const issued = Math.floor(Date.now() / 1000);
  const expires = issued + 60;
  const mac = createHmac("sha256", key)
    .update(
      [
        "DUCELIO_LEARNER_SERVICES_HMAC_SHA256_V1",
        keyId,
        canonical,
        String(issued),
        String(expires),
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
  return {
    p_key_id: keyId,
    p_issued_at: issued,
    p_expires_at: expires,
    p_mac: mac,
  };
}

describe("push subscriptions and reminders", () => {
  const endpoint = "https://fcm.googleapis.com/fcm/send/TEST-ONLY-endpoint-a";
  const keys = ["B".repeat(87), "a".repeat(22)];
  const pending = async (where = "") =>
    (
      await one<{ n: number }>(
        `select count(*)::int n from public.learner_activity_reminders r where r.status='PENDING' ${where}`,
      )
    ).n;
  it("subscribes the owner idempotently and refuses unsafe endpoints", async () => {
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/x",
      "https://127.0.0.1/push/endpoint-x",
      "https://evil.example/fcm.googleapis.com/x",
    ])
      expect(
        await rpc(q, learnerA, "subscribe_my_push", [
          bad,
          keys[0],
          keys[1],
          null,
        ]),
      ).toEqual({ ok: false, code: "INVALID_SUBSCRIPTION" });
    const first = await rpc<{
      ok: boolean;
      subscriptionId: string;
      remindersScheduled: number;
    }>(q, learnerA, "subscribe_my_push", [endpoint, keys[0], keys[1], null]);
    expect(first.ok).toBe(true);
    expect(first.remindersScheduled).toBeGreaterThan(0);
    const again = await rpc<{
      subscriptionId: string;
      remindersScheduled: number;
    }>(q, learnerA, "subscribe_my_push", [endpoint, keys[0], keys[1], null]);
    expect(again).toMatchObject({
      subscriptionId: first.subscriptionId,
      remindersScheduled: 0,
    });
    expect(
      await rpc(q, learnerA, "refresh_my_activity_reminders"),
    ).toMatchObject({
      ok: true,
      created: 0,
      pending: first.remindersScheduled,
    });
    // Every reminder is 15 minutes before its item's occupied interval.
    expect(
      (
        await one<{ n: number }>(
          `select count(*)::int n from public.learner_activity_reminders r join public.academy_schedule_items i on i.id=r.item_id
         where r.due_at <> i.starts_at - interval '15 minutes'`,
        )
      ).n,
    ).toBe(0);
    expect(await rpc(q, learnerB, "unsubscribe_my_push", [endpoint])).toEqual({
      ok: true,
      removed: false,
    });
    const upcoming = await rpc<{
      pushEnabled: boolean;
      items: { pushScheduled: boolean }[];
    }>(q, learnerA, "list_my_upcoming_reminders", [7]);
    expect(upcoming.pushEnabled).toBe(true);
    expect(upcoming.items.length).toBeGreaterThan(0);
    expect(
      await rpc<{ pushEnabled: boolean; items: unknown[] }>(
        q,
        learnerB,
        "list_my_upcoming_reminders",
        [7],
      ),
    ).toMatchObject({ pushEnabled: false, items: [] });
  });

  it("recalculates reminders when the schedule is revised", async () => {
    const current = (
      await one<{ id: string }>(
        "select id from public.academy_schedules where enrolment_id=$1 and superseded_at is null",
        [enrolA],
      )
    ).id;
    const revised = await rpc<{ ok: boolean; scheduleId: string }>(
      q,
      learnerA,
      "revise_my_academy_schedule",
      [
        enrolA,
        1,
        new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
        [1, 2, 3, 4, 5],
        "18:00",
        "Europe/London",
        randomUUID(),
      ],
    );
    expect(revised, JSON.stringify(revised)).toMatchObject({ ok: true });
    await rpc(q, learnerA, "refresh_my_activity_reminders");
    expect(await pending(`and r.schedule_id='${current}'`)).toBe(0);
    expect(
      (
        await one<{ n: number }>(
          `select count(*)::int n from public.learner_activity_reminders where schedule_id=$1 and status='CANCELLED' and cancelled_reason='SCHEDULE_REVISED'`,
          [current],
        )
      ).n,
    ).toBeGreaterThan(0);
    expect(
      await pending(`and r.schedule_id='${revised.scheduleId}'`),
    ).toBeGreaterThan(0);
  });

  it("dispatches due reminders once, removes gone subscriptions and retries failures", async () => {
    // Bring the next current-schedule item to 10 minutes from now.
    const next = await one<{ id: string }>(
      `select i.id from public.academy_schedule_items i join public.academy_schedules s on s.id=i.schedule_id
       where s.enrolment_id=$1 and s.superseded_at is null and i.starts_at>now() order by i.starts_at limit 1`,
      [enrolA],
    );
    await q("delete from public.learner_activity_reminders where item_id=$1", [
      next.id,
    ]);
    await q(
      "alter table public.academy_schedule_items disable trigger guard_history",
    );
    await q(
      "update public.academy_schedule_items set starts_at=now()+interval '10 minutes', ends_at=now()+interval '70 minutes' where id=$1",
      [next.id],
    );
    await q(
      "alter table public.academy_schedule_items enable trigger guard_history",
    );
    const payloads: string[] = [];
    const ok: PushSender = {
      async send(_target, payload) {
        payloads.push(payload);
      },
    };
    expect(
      await dispatchActivityReminders({
        rpc: anonRpc,
        controller,
        sender: null,
      }),
    ).toMatchObject({
      configured: false,
      claimed: 0,
    });
    expect(
      await dispatchActivityReminders({ rpc: anonRpc, controller, sender: ok }),
    ).toMatchObject({
      claimed: 1,
      sent: 1,
    });
    expect(JSON.parse(payloads[0])).toEqual({
      title: "Ducelio",
      body: expect.stringMatching(/starts in 15 minutes$/),
      url: "/student/timetable",
      tag: "ducelio-activity-reminder",
    });
    expect(
      await dispatchActivityReminders({ rpc: anonRpc, controller, sender: ok }),
    ).toMatchObject({
      claimed: 0,
    });
    expect(
      (
        await one(
          "select status from public.learner_activity_reminders where item_id=$1",
          [next.id],
        )
      ).status,
    ).toBe("SENT");

    // A second learner device: a 500 is retried, a 410 removes it.
    const endpointB =
      "https://updates.push.services.mozilla.com/wpush/v2/TEST-ONLY-b";
    await rpc(q, learnerA, "subscribe_my_push", [
      endpointB,
      "C".repeat(87),
      "b".repeat(22),
      null,
    ]);
    await q(
      "update public.learner_activity_reminders set next_attempt_at=now() where item_id=$1 and status='PENDING'",
      [next.id],
    );
    let status = 500;
    const flaky: PushSender = {
      async send() {
        throw Object.assign(new Error("push failed"), { statusCode: status });
      },
    };
    expect(
      await dispatchActivityReminders({
        rpc: anonRpc,
        controller,
        sender: flaky,
      }),
    ).toMatchObject({
      claimed: 1,
      retrying: 1,
    });
    await q(
      "update public.learner_activity_reminders set next_attempt_at=now() where status='PENDING' and item_id=$1",
      [next.id],
    );
    status = 410;
    expect(
      await dispatchActivityReminders({
        rpc: anonRpc,
        controller,
        sender: flaky,
      }),
    ).toMatchObject({
      claimed: 1,
      gone: 1,
    });
    expect(
      (
        await one<{ n: number }>(
          "select count(*)::int n from public.learner_push_subscriptions where endpoint=$1",
          [endpointB],
        )
      ).n,
    ).toBe(0);
    expect(
      (
        await one<{ n: number }>(
          "select count(*)::int n from public.learner_push_subscriptions where endpoint=$1",
          [endpoint],
        )
      ).n,
    ).toBe(1);
  });

  it("moves an endpoint to the learner now signed in on that browser", async () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/TEST-ONLY-endpoint-a";
    await rpc(q, learnerB, "subscribe_my_push", [
      endpoint,
      keys[0],
      keys[1],
      null,
    ]);
    expect(
      await one(
        "select user_id from public.learner_push_subscriptions where endpoint=$1",
        [endpoint],
      ),
    ).toEqual({ user_id: learnerB.id });
    expect(await pending(`and r.learner_id='${learnerA.id}'`)).toBe(0);
    expect(await rpc(q, learnerB, "unsubscribe_my_push", [endpoint])).toEqual({
      ok: true,
      removed: true,
    });
  });
});

describe("certificates", () => {
  let code: string;
  it("issues only from a completion row, once, with one email", async () => {
    expect(await rpc(q, learnerA, "issue_my_certificate", [enrolA])).toEqual({
      ok: false,
      code: "NOT_COMPLETED",
    });
    await expect(
      q(
        `insert into public.learner_certificates(enrolment_id,learner_id,verification_code,learner_name,course_title,issuer_name,completed_at)
         values($1,$2,'AAAA-BBBB-CCCC-DDDD','x','y','z',now())`,
        [enrolA, learnerA.id],
      ),
    ).rejects.toThrow(/foreign key/);
    await q(
      "insert into public.academy_completions(enrolment_id,course_score_bp,pass_mark_bp,component_scores) values($1,8000,7000,'{}')",
      [enrolA],
    );
    await expect(
      rpc(q, learnerB, "issue_my_certificate", [enrolA]),
    ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
    // Demo content never yields a certificate, and is not offered as one.
    expect(await rpc(q, learnerA, "issue_my_certificate", [enrolA])).toEqual({
      ok: false,
      code: "DEMO_COURSE",
    });
    expect(
      (await rpc<{ eligible: unknown[] }>(q, learnerA, "get_my_certificates"))
        .eligible,
    ).toEqual([]);
    // TEST ONLY: the database owner marks this synthetic package as a
    // non-demo course to exercise issuance (history guard bypassed
    // explicitly, which no RPC can do).
    await q(
      "alter table public.academy_course_packages disable trigger guard_history",
    );
    try {
      await q(
        `update public.academy_course_packages pk set raw_package = jsonb_set(raw_package, '{course,demoContent}', 'false')
          from public.academy_courses c join public.academy_enrolments e on e.course_id = c.id
         where e.id = $1 and pk.id = c.package_id`,
        [enrolA],
      );
    } finally {
      await q(
        "alter table public.academy_course_packages enable trigger guard_history",
      );
    }
    // The certificate carries the PUBLISHED snapshot, not a later edit.
    await q(
      `update public.programmes p set examination_body = 'Edited after publication'
        from public.programme_versions pv join public.academy_courses c on c.programme_version_id = pv.id
        join public.academy_enrolments e on e.course_id = c.id
       where e.id = $1 and p.id = pv.programme_id`,
      [enrolA],
    );
    expect(
      (await rpc<{ eligible: unknown[] }>(q, learnerA, "get_my_certificates"))
        .eligible,
    ).toHaveLength(1);
    const issued = await rpc<{
      ok: boolean;
      replayed: boolean;
      certificate: Record<string, unknown>;
    }>(q, learnerA, "issue_my_certificate", [enrolA]);
    expect(issued).toMatchObject({
      ok: true,
      replayed: false,
      certificate: {
        learnerName: "Ada Lovelace",
        issuerName: "Synthetic Tenant One",
        examinationBody: "CompTIA",
        revoked: false,
        emailDelivery: "QUEUED",
      },
    });
    code = issued.certificate.verificationCode as string;
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
    const again = await rpc<{
      replayed: boolean;
      certificate: { certificateId: string };
    }>(q, learnerA, "issue_my_certificate", [enrolA]);
    expect(again.replayed).toBe(true);
    expect(again.certificate.certificateId).toBe(
      issued.certificate.certificateId,
    );
    expect(
      (
        await one<{ n: number }>(
          "select count(*)::int n from public.learner_email_outbox where kind='CERTIFICATE_ISSUED'",
        )
      ).n,
    ).toBe(1);
    expect(
      await rpc<{ certificates: unknown[]; eligible: unknown[] }>(
        q,
        learnerA,
        "get_my_certificates",
      ),
    ).toMatchObject({
      certificates: [{ verificationCode: code }],
      eligible: [],
    });
    await expect(
      rpc(q, learnerB, "get_my_certificate", [
        issued.certificate.certificateId,
      ]),
    ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
  });

  it("verifies publicly with minimal fields and reports revocation", async () => {
    const verified = await rpc<Record<string, unknown>>(
      q,
      null,
      "verify_certificate",
      [code.toLowerCase().replaceAll("-", " ")],
    );
    expect(Object.keys(verified).sort()).toEqual([
      "completedOn",
      "courseTitle",
      "found",
      "issuedOn",
      "issuerName",
      "learnerName",
      "preparationCourse",
      "revoked",
      "revokedOn",
      "valid",
      "verificationCode",
    ]);
    expect(verified).toMatchObject({
      found: true,
      valid: true,
      learnerName: "Ada Lovelace",
      preparationCourse: true,
    });
    expect(
      await rpc(q, null, "verify_certificate", ["ZZZZ-ZZZZ-ZZZZ-ZZZZ"]),
    ).toEqual({ found: false });
    expect(await rpc(q, null, "verify_certificate", ["short"])).toEqual({
      found: false,
    });
    await expect(
      q(
        "update public.learner_certificates set learner_name='Someone Else' where verification_code=$1",
        [code],
      ),
    ).rejects.toThrow("IMMUTABLE_HISTORY");
    await q(
      "update public.learner_certificates set revoked_at=now(), revoked_reason='TEST ONLY revocation' where verification_code=$1",
      [code],
    );
    expect(await rpc(q, null, "verify_certificate", [code])).toMatchObject({
      found: true,
      valid: false,
      revoked: true,
    });
  });
});

describe("payment receipts", () => {
  const now = () => Math.floor(Date.now() / 1000);
  function fulfil(orderId: string, status: string, eventId: string) {
    const iat = now();
    const exp = iat + 60;
    const session = "cs_test_learner_services_1";
    const canonical = [
      "DUCELIO_ACADEMY_FULFILLMENT_HMAC_SHA256_V1",
      "ACADEMY_COMMERCE_V1",
      keyId,
      "STRIPE",
      orderId,
      session,
      eventId,
      "10000",
      "GBP",
      status,
      String(iat),
      String(exp),
    ].join("\n");
    const mac = createHmac("sha256", key)
      .update(canonical, "utf8")
      .digest("hex");
    return rpc<{ ok: boolean; fulfilled?: boolean; replay?: boolean }>(
      q,
      null,
      "fulfill_academy_order",
      [
        keyId,
        orderId,
        "STRIPE",
        session,
        eventId,
        10000,
        "GBP",
        status,
        iat,
        exp,
        mac,
      ],
    );
  }
  it("issues exactly one receipt for a verified paid fulfilled order", async () => {
    const order = await rpc<{
      ok: boolean;
      orderId: string;
      amountMinor: number;
    }>(q, learnerB, "create_unified_course_order", [
      "learner-services-course",
      null,
    ]);
    expect(order).toMatchObject({ ok: true, amountMinor: 10000 });
    expect(
      await rpc(q, learnerB, "issue_my_payment_receipt", [order.orderId]),
    ).toEqual({
      ok: false,
      code: "NOT_ELIGIBLE",
    });
    expect(
      await fulfil(order.orderId, "UNPAID", "evt_test_unpaid"),
    ).toMatchObject({ ok: true, fulfilled: false });
    expect(await rpc(q, learnerB, "list_my_payment_receipts")).toEqual([]);
    expect(await fulfil(order.orderId, "PAID", "evt_test_paid")).toMatchObject({
      ok: true,
      fulfilled: true,
    });
    expect(await fulfil(order.orderId, "PAID", "evt_test_paid")).toMatchObject({
      ok: true,
      replay: true,
    });
    const receipts = await q(
      "select id,receipt_number from public.learner_payment_receipts where order_id=$1",
      [order.orderId],
    );
    expect(receipts.rows).toHaveLength(1);
    expect(receipts.rows[0].receipt_number).toMatch(/^DUC-R-\d{4}-\d{6}$/);
    const issued = await rpc<{ ok: boolean; receipt: Record<string, unknown> }>(
      q,
      learnerB,
      "issue_my_payment_receipt",
      [order.orderId],
    );
    expect(issued).toMatchObject({
      ok: true,
      receipt: {
        receiptId: receipts.rows[0].id,
        amountMinor: 10000,
        currency: "GBP",
        provider: "Synthetic Tenant One",
        refund: null,
        emailDelivery: "QUEUED",
      },
    });
    expect(
      (
        await one<{ n: number }>(
          "select count(*)::int n from public.learner_email_outbox where kind='PAYMENT_RECEIPT' and recipient=$1",
          [learnerB.email],
        )
      ).n,
    ).toBe(1);
    expect(
      await rpc<unknown[]>(q, learnerB, "list_my_payment_receipts"),
    ).toHaveLength(1);
    await expect(
      rpc(q, learnerA, "issue_my_payment_receipt", [order.orderId]),
    ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
    await expect(
      rpc(q, learnerA, "get_my_payment_receipt", [receipts.rows[0].id]),
    ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
    await expect(
      q("delete from public.learner_payment_receipts where order_id=$1", [
        order.orderId,
      ]),
    ).rejects.toThrow("IMMUTABLE_HISTORY");
    // A verified refund is shown on the same receipt, never a new one.
    await q(
      "insert into public.academy_order_refunds(order_id,charge_id,event_id,amount_minor,currency) values($1,'ch_test','evt_test_refund',10000,'GBP')",
      [order.orderId],
    );
    expect(
      (
        await rpc<{ refund: unknown }>(q, learnerB, "get_my_payment_receipt", [
          receipts.rows[0].id,
        ])
      ).refund,
    ).toMatchObject({ amountMinor: 10000, currency: "GBP" });
  });

  it("attaches rendered PDFs when the dispatcher sends certificate and receipt mail", async () => {
    const sent: OutgoingEmail[] = [];
    const fake: EmailAdapter = {
      name: "fake",
      async send(email) {
        sent.push(email);
        return { providerMessageId: `fake-pdf-${sent.length}` };
      },
    };
    const run = await dispatchLearnerEmail({
      rpc: anonRpc,
      controller,
      adapter: fake,
      appUrl: "https://example.test",
    });
    expect(run).toMatchObject({ claimed: 2, sent: 2 });
    for (const email of sent) {
      expect(email.attachments).toHaveLength(1);
      expect(
        Buffer.from(email.attachments[0].content).subarray(0, 5).toString(),
      ).toBe("%PDF-");
      expect(email.text).not.toContain("{{APP_URL}}");
    }
    expect(
      sent.find((e) => e.subject.startsWith("Your Ducelio certificate"))?.text,
    ).toContain("https://example.test/verify?code=");
  });
});
