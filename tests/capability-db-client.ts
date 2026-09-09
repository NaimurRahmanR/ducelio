import type { PGlite } from "@electric-sql/pglite";

// Test-only adapter for the small PostgREST subset used by the real read services.
// Queries/RPCs execute in PGlite under the authenticated role and all repository RLS.
// This does not simulate hosted PostgREST, cookies or Supabase Auth acceptance.
type Reply = { data: unknown; error: { code: string; message: string } | null };
type Call = {
  table?: string;
  rpc?: string;
  select?: string;
  args?: Record<string, unknown>;
};
export type CapabilityDbState = {
  authUser: { id: string; email_confirmed_at: string | null } | null;
  calls: Call[];
  failTable?: string;
  failRpc?: string;
};

function identifier(value: string) {
  if (!/^[a-z_]+$/.test(value)) throw new Error("Unsupported test identifier");
  return `"${value}"`;
}

export function capabilityDbClient(db: PGlite, state: CapabilityDbState) {
  async function reply(work: () => Promise<unknown>): Promise<Reply> {
    // Preserve the surrounding fixture transaction when an RPC intentionally denies.
    await db.exec("savepoint capability_test_call");
    try {
      const data = await work();
      await db.exec("release savepoint capability_test_call");
      return { data, error: null };
    } catch (error) {
      await db.exec(
        "rollback to savepoint capability_test_call; release savepoint capability_test_call",
      );
      return {
        data: null,
        error: {
          code:
            typeof error === "object" && error && "code" in error
              ? String(error.code)
              : "TEST_FAILURE",
          message: "Private database error sentinel",
        },
      };
    }
  }

  return {
    auth: {
      getUser: async () => ({ data: { user: state.authUser }, error: null }),
    },
    from(table: string) {
      if (
        ![
          "app_users",
          "role_grants",
          "enrolments",
          "lessons",
          "lesson_objectives",
        ].includes(table)
      )
        throw new Error("Unexpected table access in capability test");
      const call: Call = { table };
      state.calls.push(call);
      let columns = "";
      const filters: string[] = [];
      const params: unknown[] = [];
      let order = "";
      let limit = "";
      let singular = false;
      let requireOne = false;

      async function execute(): Promise<Reply> {
        return reply(async () => {
          if (state.failTable === table) throw new Error("Database failure");
          let join = "";
          let nested = "";
          const projection = columns.replace(
            /programme_versions\(([a-z_,]+)\)/,
            (_match, fields: string) => {
              join =
                " join public.programme_versions v on v.id=t.programme_version_id";
              nested = `json_build_object(${fields
                .split(",")
                .map((field) => `'${field}',v.${identifier(field)}`)
                .join(",")}) as programme_versions`;
              return "";
            },
          );
          const selected = projection
            .split(",")
            .filter(Boolean)
            .map((field) => `t.${identifier(field)}`);
          if (nested) selected.push(nested);
          const sql = `select ${selected.join(",")} from public.${identifier(table)} t${join}${filters.length ? ` where ${filters.join(" and ")}` : ""}${order}${limit}`;
          // PostgreSQL JSON represents DATE as YYYY-MM-DD, like PostgREST;
          // PGlite's direct column decoder otherwise returns a JavaScript Date.
          const result = await db.query<{ row: Record<string, unknown> }>(
            `select row_to_json(result) as row from (${sql}) result`,
            params,
          );
          const rows = result.rows.map((entry) => entry.row);
          if (singular) {
            if (rows.length > 1 || (requireOne && rows.length !== 1))
              throw new Error("Unexpected row count");
            return rows[0] ?? null;
          }
          return rows;
        });
      }
      const query = {
        select(value: string) {
          columns = value;
          call.select = value;
          return query;
        },
        eq(column: string, value: unknown) {
          params.push(value);
          filters.push(`t.${identifier(column)}=$${params.length}`);
          return query;
        },
        gt(column: string, value: unknown) {
          params.push(value);
          filters.push(`t.${identifier(column)}>$${params.length}`);
          return query;
        },
        order(column: string) {
          order = ` order by t.${identifier(column)}`;
          return query;
        },
        limit(count: number) {
          params.push(count);
          limit = ` limit $${params.length}`;
          return query;
        },
        single() {
          singular = true;
          requireOne = true;
          return execute();
        },
        maybeSingle() {
          singular = true;
          return execute();
        },
        then<T = Reply, U = never>(
          fulfilled?: ((value: Reply) => T | PromiseLike<T>) | null,
          rejected?: ((error: unknown) => U | PromiseLike<U>) | null,
        ) {
          return execute().then(fulfilled, rejected);
        },
      };
      return query;
    },
    async rpc(name: string, args?: Record<string, unknown>) {
      if (
        ![
          "current_academic_activity_state",
          "academic_action_allowed",
          "assert_academic_action_allowed",
        ].includes(name)
      )
        throw new Error("Unexpected RPC in capability test");
      state.calls.push({ rpc: name, args });
      return reply(async () => {
        if (state.failRpc === name) throw new Error("RPC failure");
        const values = args ? [args.p_action] : [];
        const { rows } = await db.query<{ value: unknown }>(
          `select public.${identifier(name)}(${values.length ? "$1" : ""}) as value`,
          values,
        );
        return rows[0].value;
      });
    },
  };
}
