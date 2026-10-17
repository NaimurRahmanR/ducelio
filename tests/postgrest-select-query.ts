import type { PGlite } from "@electric-sql/pglite";

// Test-only, faithful subset of postgrest-js's table select builder, executed
// for real against PGlite under whatever role/JWT the test has set (so every
// RLS policy applies exactly as through hosted PostgREST). It supports what
// the learner projections use -- select, eq, in, order (repeatable; PostgREST
// defaults: ascending NULLS LAST, descending NULLS FIRST), range and limit --
// and throws on anything else, so production code can never silently rely on
// an unsupported filter. An empty .in() list throws: real PostgREST does not
// guarantee PGlite's `= any('{}')` semantics, so production code must
// short-circuit before building one.
type Result = { data: unknown; error: unknown; status?: number };
// Supabase's default PostgREST max-rows: no response carries more rows,
// whatever limit/range the client asked for.
export const POSTGREST_MAX_ROWS = 1000;
export function postgrestSelectQuery(options: {
  db: PGlite;
  table: string;
  // The SQL select list for this table (alias `t`), standing in for the
  // PostgREST select string (including any embed).
  columns: string;
  join?: string;
  filterColumns: readonly string[];
  onSelect?: (select: string) => void;
  // Returns a canned result (e.g. an injected failure) instead of querying.
  intercept?: () => Result | undefined;
}) {
  const filters: string[] = [];
  const params: unknown[] = [];
  const orders: string[] = [];
  let limit: number | null = null;
  let offset = 0;
  const column = (col: string) => {
    if (!options.filterColumns.includes(col) || !/^[a-z_]+$/.test(col))
      throw new Error(`Unsupported filter column: ${col}`);
    return "t." + col;
  };
  const query = {
    select(value: string) {
      options.onSelect?.(value);
      return query;
    },
    eq(col: string, value: unknown) {
      params.push(value);
      filters.push(`${column(col)}=$${params.length}`);
      return query;
    },
    in(col: string, values: unknown[]) {
      if (values.length === 0)
        throw new Error(
          "Unsafe empty .in() filter: production code must short-circuit before this point.",
        );
      params.push(values);
      filters.push(`${column(col)}=any($${params.length})`);
      return query;
    },
    order(col: string, opts: { ascending?: boolean } = {}) {
      if (!/^[a-z_]+$/.test(col)) throw new Error("Unsupported order column");
      orders.push(
        opts.ascending === false
          ? `t.${col} desc nulls first`
          : `t.${col} asc nulls last`,
      );
      return query;
    },
    range(from: number, to: number) {
      offset = from;
      limit = to - from + 1;
      return query;
    },
    limit(n: number) {
      limit = n;
      return query;
    },
    then(resolve: (v: Result) => unknown, reject: (e: unknown) => unknown) {
      const canned = options.intercept?.();
      if (canned) return Promise.resolve(canned).then(resolve, reject);
      const order = orders.length ? orders.join(",") : "t.id";
      const sql =
        "select (to_jsonb(q) - '__ord') as data from (select " +
        options.columns +
        ", row_number() over (order by " +
        order +
        ") as __ord from public." +
        options.table +
        " t" +
        (options.join ?? "") +
        (filters.length ? " where " + filters.join(" and ") : "") +
        " order by " +
        order +
        " limit " +
        Math.min(limit ?? POSTGREST_MAX_ROWS, POSTGREST_MAX_ROWS) +
        " offset " +
        offset +
        ") q order by q.__ord";
      return options.db
        .query<{ data: unknown }>(sql, params)
        .then((r) => ({ data: r.rows.map((x) => x.data), error: null }))
        .then(resolve, reject);
    },
  };
  return query;
}
