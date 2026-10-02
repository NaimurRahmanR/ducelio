import "server-only";
import { z } from "zod";
import {
  accountStatusInput,
  accountStatusSchema,
  peopleDirectorySchema,
  peopleQuerySchema,
  roleChangeInput,
  staffProfileInput,
  staffRoleSchema,
  type PeopleAuditEntry,
  type PeopleAuditKind,
} from "@/domain/admin-control-plane";
import { requireAnyRole } from "./identity";
import { createSupabase } from "./supabase";
import { adminControlRpc, adminInput } from "./admin-control-rpc";

// People / staff control plane. PLATFORM_ADMIN only, both here and in the
// database. Ducelio does not create Supabase Auth users: a person signs up
// (or is provisioned by the identity provider) first, and is then located
// and managed here by their existing app_users identity.
const PLATFORM_ADMIN = ["PLATFORM_ADMIN"] as const;

const changeResult = z.object({ changed: z.boolean() });

const auditRow = z.object({
  id: z.uuid(),
  actor_id: z.uuid().nullable(),
  action: z.string(),
  target_type: z.enum(["role_grants", "staff_profiles", "app_users"]),
  target_id: z.uuid(),
  reason: z.string(),
  occurred_at: z.string(),
  before_state: z.record(z.string(), z.unknown()).nullable(),
  after_state: z.record(z.string(), z.unknown()).nullable(),
});

function auditKind(row: z.infer<typeof auditRow>): PeopleAuditKind | null {
  if (row.target_type === "role_grants")
    return row.action === "INSERT"
      ? "ROLE_GRANTED"
      : row.action === "DELETE"
        ? "ROLE_REVOKED"
        : null;
  if (row.target_type === "staff_profiles")
    return row.action === "INSERT"
      ? "STAFF_PROFILE_CREATED"
      : row.action === "UPDATE"
        ? "STAFF_PROFILE_UPDATED"
        : null;
  return row.action === "ACCOUNT_DEACTIVATED" ||
    row.action === "ACCOUNT_REACTIVATED"
    ? row.action
    : null;
}

// Recent people-administration audit, projected to kind/role/names/reason.
// Raw before/after state never leaves the server, and the automatic STUDENT
// grant written by sign-up provisioning is omitted as noise.
async function getPeopleAudit(): Promise<PeopleAuditEntry[]> {
  const client = await createSupabase();
  const { data, error } = await client
    .from("audit_events")
    .select(
      "id,actor_id,action,target_type,target_id,reason,occurred_at,before_state,after_state",
    )
    .in("target_type", ["role_grants", "staff_profiles", "app_users"])
    .order("occurred_at", { ascending: false })
    .limit(80);
  if (error) throw new Error("People audit could not be loaded.");
  const rows = z
    .array(auditRow)
    .parse(data)
    .flatMap((row) => {
      const kind = auditKind(row);
      const state = row.after_state ?? row.before_state ?? {};
      const role = typeof state.role === "string" ? state.role : null;
      return kind && role !== "STUDENT" ? [{ row, kind, role }] : [];
    })
    .slice(0, 30);
  const ids = [
    ...new Set(
      rows.flatMap(({ row }) =>
        row.actor_id ? [row.actor_id, row.target_id] : [row.target_id],
      ),
    ),
  ];
  const names = new Map<string, string>();
  if (ids.length) {
    const users = await client
      .from("app_users")
      .select("id,display_name")
      .in("id", ids);
    if (users.error) throw new Error("People audit could not be loaded.");
    for (const user of z
      .array(z.object({ id: z.uuid(), display_name: z.string() }))
      .parse(users.data))
      names.set(user.id, user.display_name);
  }
  return rows.map(({ row, kind, role }) => ({
    id: row.id,
    kind,
    role,
    actorName: row.actor_id
      ? (names.get(row.actor_id) ?? "Unknown account")
      : "Database provisioning",
    targetName: names.get(row.target_id) ?? "Unknown account",
    reason: row.reason,
    occurredAt: row.occurred_at,
  }));
}

export async function getPeopleWorkspace(query?: string | null) {
  const actor = await requireAnyRole(PLATFORM_ADMIN);
  const q = peopleQuerySchema.safeParse(query ?? "");
  const search = q.success ? q.data : "";
  const [directory, audit] = await Promise.all([
    adminControlRpc(
      PLATFORM_ADMIN,
      "admin_list_people",
      { p_query: search || null },
      peopleDirectorySchema,
    ),
    getPeopleAudit(),
  ]);
  return { actor, query: search, directory, audit };
}

export async function setStaffProfile(value: unknown) {
  const p = adminInput(staffProfileInput, value);
  return adminControlRpc(
    PLATFORM_ADMIN,
    "admin_set_staff_profile",
    { p_user_id: p.userId, p_title: p.title, p_reason: p.reason },
    changeResult.extend({ created: z.boolean() }),
  );
}

export async function grantStaffRole(value: unknown) {
  const p = adminInput(roleChangeInput, value);
  return adminControlRpc(
    PLATFORM_ADMIN,
    "admin_grant_role",
    { p_user_id: p.userId, p_role: p.role, p_reason: p.reason },
    changeResult.extend({ role: staffRoleSchema }),
  );
}

export async function revokeStaffRole(value: unknown) {
  const p = adminInput(roleChangeInput, value);
  return adminControlRpc(
    PLATFORM_ADMIN,
    "admin_revoke_role",
    { p_user_id: p.userId, p_role: p.role, p_reason: p.reason },
    changeResult.extend({ role: staffRoleSchema }),
  );
}

export async function setAccountStatus(value: unknown) {
  const p = adminInput(accountStatusInput, value);
  return adminControlRpc(
    PLATFORM_ADMIN,
    "admin_set_account_status",
    { p_user_id: p.userId, p_status: p.status, p_reason: p.reason },
    changeResult.extend({ status: accountStatusSchema }),
  );
}
