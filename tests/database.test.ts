import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";
import {
  assertMatchingVersion,
  assignmentSchema,
  studyPlanItemSchema,
} from "@/domain/academy";
let db: PGlite;
beforeAll(async () => {
  db = await testDatabase();
});
afterAll(async () => {
  await db?.close();
});
describe("PostgreSQL migrations and constraints", () => {
  it("seeds five demo objectives", async () => {
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.lesson_objectives",
        )
      ).rows[0].count,
    ).toBe(5);
  });
  it("prevents duplicate active counsellors", async () => {
    await expect(
      db.exec(
        "insert into public.counsellor_assignments(student_id,counsellor_id) values ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002')",
      ),
    ).rejects.toThrow();
  });
  it("freezes published objectives", async () => {
    await expect(
      db.exec("update public.lesson_objectives set description='Changed'"),
    ).rejects.toThrow("immutable");
    await expect(
      db.exec(
        "insert into public.lesson_objectives(lesson_id,programme_version_id,description,position) values ('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','Extra',6)",
      ),
    ).rejects.toThrow("immutable");
  });
  it("rejects cross-version enrolment", async () => {
    await db.exec(
      "insert into public.programme_versions(id,programme_id,label) values ('20000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001','Other demo')",
    );
    await expect(
      db.exec(
        "insert into public.enrolments(student_id,cohort_id,programme_version_id) values ('10000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000003')",
      ),
    ).rejects.toThrow();
  });
  it("rejects cross-student plan items", async () => {
    await expect(
      db.exec(
        "insert into public.study_plan_items(plan_id,student_id,title,due_on,created_by) values ('60000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','Bad','2026-09-09','10000000-0000-4000-8000-000000000003')",
      ),
    ).rejects.toThrow();
  });
});
describe("domain validation", () => {
  it("rejects mismatched versions", () => {
    expect(() => assertMatchingVersion("a", "b")).toThrow();
  });
  it("rejects self assignment", () => {
    expect(
      assignmentSchema.safeParse({
        studentId: "10000000-0000-4000-8000-000000000001",
        counsellorId: "10000000-0000-4000-8000-000000000001",
        reason: "test reason",
      }).success,
    ).toBe(false);
  });
  it("rejects invalid dates and empty plan items", () => {
    expect(
      studyPlanItemSchema.safeParse({
        planId: "60000000-0000-4000-8000-000000000001",
        studentId: "10000000-0000-4000-8000-000000000001",
        title: " ",
        dueOn: "2026-02-31",
      }).success,
    ).toBe(false);
  });
});

describe("identity provisioning", () => {
  it("maps auth identity once and ignores role metadata", async () => {
    await db.exec(
      `insert into auth.users(id,email,raw_user_meta_data) values ('90000000-0000-4000-8000-000000000001','test@example.com','{"display_name":"New Learner","role":"PLATFORM_ADMIN"}')`,
    );
    const users = await db.query<{ id: string; display_name: string }>(
      "select id,display_name from public.app_users where auth_user_id='90000000-0000-4000-8000-000000000001'",
    );
    expect(users.rows).toHaveLength(1);
    expect(users.rows[0].display_name).toBe("New Learner");
    const roles = await db.query<{ role: string }>(
      "select role from public.role_grants where user_id=$1",
      [users.rows[0].id],
    );
    expect(roles.rows.map((r) => r.role)).toEqual(["STUDENT"]);
    await expect(
      db.exec(
        "insert into public.app_users(auth_user_id,display_name) values ('90000000-0000-4000-8000-000000000001','Duplicate')",
      ),
    ).rejects.toThrow();
  });
});

describe("final curriculum and migration audit", () => {
  it("keeps every application table under RLS", async () => {
    const rows = await db.query<{ relname: string }>(
      "select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity",
    );
    expect(rows.rows).toEqual([]);
  });
  // Independent review (PR13 V3 correction, defect 1): PostgreSQL functions
  // may be OVERLOADED -- a name-only allowlist would silently accept a
  // future same-named function with a different argument signature that
  // accidentally becomes SECURITY DEFINER + anon-executable. The baseline
  // must therefore identify the exact CALLABLE signature (namespace +
  // function + identity argument types), never merely a function name.
  // pg_get_function_identity_arguments includes parameter NAMES
  // ("p_key_id uuid, ..."); the canonical callable signature is the bare
  // TYPE list, built directly from proargtypes so it is unambiguous and
  // matches PostgreSQL's own regprocedure argument-type rendering.
  const anonSecdefSignatureSql = `
    select n.nspname||'.'||p.proname||'('
      ||coalesce((select string_agg(format_type(t,null),',' order by ord)
                  from unnest(p.proargtypes::oid[]) with ordinality as u(t,ord)),'')
      ||')' as sig
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef and has_function_privilege('anon',p.oid,'EXECUTE')
  `;
  it("does not grant anonymous execution of security-definer functions, except the exact reviewed commerce signatures", async () => {
    const rows = await db.query<{ sig: string }>(anonSecdefSignatureSql);
    // PR13 deliberately introduces exactly three anon-callable surfaces,
    // each individually reviewed and bounded by its own exact argument
    // signature: two read-only public course-catalogue projections (never
    // protected content -- see commercial-v1-commerce-domain.test.ts) and
    // the payment-fulfillment RPC a Stripe webhook must reach despite
    // having no learner session at all -- gated entirely by a
    // cryptographic controller claim, never by role (see
    // commercial-v1-commerce-db.test.ts's HMAC verification suite). This
    // asserts EXACT SET EQUALITY, both directions: no unexpected extra
    // signature (a different overload of one of these names, or any other
    // security-definer function) and no expected signature missing or
    // changed.
    const allowed = new Set([
      "public.list_commercial_v1_offers()",
      "public.get_commercial_v1_offer(text)",
      "public.fulfill_commercial_v1_order(uuid,uuid,text,text,text,integer,text,text,bigint,bigint,text)",
      // Migration 045: purpose-separated signed webhook receipt/refund envelope.
      // No anonymous operator authority; all claims require the controller MAC.
      "public.apply_commercial_v1_commerce_operation(uuid,text,bigint,bigint,text)",
      // Migration 060: the read-only Ducelio Academy catalogue of PUBLISHED
      // offers and approved per-format prices (never package content).
      "public.list_academy_catalogue()",
    ]);
    expect(new Set(rows.rows.map((r) => r.sig))).toEqual(allowed);
  });
  it("the exact-signature comparison is genuinely signature-sensitive, not name-only -- a differently-shaped overload of an allowed name is never silently permitted (structural negative regression, rolled back)", async () => {
    await db.exec("reset role");
    await db.exec("begin");
    try {
      await db.exec(`
        create function public.get_commercial_v1_offer(p_id uuid) returns jsonb
        language sql security definer set search_path='' as $$ select '{}'::jsonb $$;
        grant execute on function public.get_commercial_v1_offer(uuid) to anon;
      `);
      const rows = await db.query<{ sig: string }>(
        anonSecdefSignatureSql + " and p.proname='get_commercial_v1_offer'",
      );
      const sigs = rows.rows.map((r) => r.sig).sort();
      // Both the reviewed text-arg overload and the newly introduced
      // uuid-arg overload are anon-executable now -- proving the harness
      // can even observe two distinct overloads of the same name.
      expect(sigs).toEqual([
        "public.get_commercial_v1_offer(text)",
        "public.get_commercial_v1_offer(uuid)",
      ]);
      // The reviewed allowlist only ever names the text-arg overload. A
      // name-only baseline would have treated the uuid-arg overload as
      // already covered merely because a function of that name was
      // expected; the exact-signature comparison must not.
      const reviewedOnly = new Set(["public.get_commercial_v1_offer(text)"]);
      expect(sigs.filter((s) => !reviewedOnly.has(s))).toEqual([
        "public.get_commercial_v1_offer(uuid)",
      ]);
    } finally {
      await db.exec("rollback");
    }
    // The rollback leaves the shared fixture exactly as every other test
    // in this file expects it.
    const after = await db.query<{ sig: string }>(
      anonSecdefSignatureSql + " and p.proname='get_commercial_v1_offer'",
    );
    expect(after.rows.map((r) => r.sig)).toEqual([
      "public.get_commercial_v1_offer(text)",
    ]);
  });
  it("keeps enrolled identity and curriculum history fixed", async () => {
    await expect(
      db.exec(
        "update public.enrolments set student_id='10000000-0000-4000-8000-000000000003'",
      ),
    ).rejects.toThrow("immutable");
  });
  it("rejects enrolment into a draft version", async () => {
    await db.exec(
      "insert into public.cohorts(id,programme_version_id,title,starts_on) values('50000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000003','Draft cohort','2026-09-01')",
    );
    await expect(
      db.exec(
        "insert into public.enrolments(student_id,cohort_id,programme_version_id) values('10000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000003')",
      ),
    ).rejects.toThrow("published");
  });
  it("audits curriculum content creation", async () => {
    expect(
      (
        await db.query(
          "select * from public.audit_events where target_type='lesson_objectives' and action='INSERT'",
        )
      ).rows,
    ).toHaveLength(5);
  });
});
