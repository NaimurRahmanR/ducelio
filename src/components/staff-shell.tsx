import Link from "next/link";
import { ArrowLeft, ShieldCheck, HeartHandshake } from "lucide-react";
import { Brand, Badge } from "./ui";
import { logout } from "@/app/auth/actions";
import type { ReactNode } from "react";
import type { Role } from "@/domain/academy";
import { AdminShell, destinationForSection } from "./admin-shell";

// Titles for the pre-existing technical routes when shown inside the admin
// control centre. Their content, forms and server checks are unchanged.
const TECHNICAL_TITLES: Record<string, string> = {
  People: "People and roles",
  Cohorts: "Cohorts",
  "Course Engineering": "Course engineering",
  Activation: "Course activation",
  "Policy setup": "Grading and result policy setup",
  "Grade recovery": "Examiner grade recovery",
  "Academic review": "Academic review",
  "Academic results": "Academic results",
  Agents: "AI agent configuration",
  Commerce: "Commerce operations",
};

// Workspace sections rendered inside /admin?section=. Cohorts and
// Announcements were placeholders; Cohorts is now the real /admin/cohorts
// control plane and Announcements is not implemented, so neither appears.
export const adminSections = [
  "Overview",
  "Programmes",
  "Resources",
  "Students",
  "Counsellors",
  "Sessions",
  "Evidence",
  "Assignments",
  "Assessments",
  "Notifications",
  "Registry",
  "Audit",
] as const;

export function adminSectionsForRoles(roles: Role[]) {
  if (roles.includes("PLATFORM_ADMIN")) return [...adminSections];

  const allowed = new Set<string>(["Overview"]);
  if (roles.includes("ACADEMIC_ADMIN")) {
    for (const section of adminSections) {
      if (section !== "Registry" && section !== "Audit") allowed.add(section);
    }
  }
  if (roles.includes("REGISTRAR")) allowed.add("Registry");

  return adminSections.filter((section) => allowed.has(section));
}

// Commercial V1 control-plane routes. Each entry is a real, implemented
// route whose page enforces the same roles server-side (and whose database
// RPCs enforce them again); the menu only aids discovery.
export const adminControlRoutes = [
  { label: "People", href: "/admin/people", roles: ["PLATFORM_ADMIN"] },
  {
    label: "Cohorts",
    href: "/admin/cohorts",
    roles: ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"],
  },
  {
    label: "Course Engineering",
    href: "/admin/course-engineering",
    roles: ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"],
  },
  {
    label: "Activation",
    href: "/admin/activation",
    roles: ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"],
  },
  {
    label: "Policy setup",
    href: "/admin/activation/policy",
    roles: ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"],
  },
  {
    label: "Grade recovery",
    href: "/admin/activation/recovery",
    roles: ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"],
  },
  {
    label: "Academic review",
    href: "/admin/academic-review",
    roles: ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"],
  },
  {
    label: "Academic results",
    href: "/admin/academic-results",
    roles: ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"],
  },
  {
    label: "Agents",
    href: "/admin/agents",
    roles: ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"],
  },
  {
    label: "Commerce",
    href: "/admin/commerce",
    roles: ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"],
  },
] as const satisfies readonly {
  label: string;
  href: string;
  roles: readonly Role[];
}[];

export function adminControlRoutesForRoles(roles: Role[]) {
  return adminControlRoutes.filter((route) =>
    route.roles.some((role) => roles.includes(role)),
  );
}

export function StaffShell({
  children,
  kind,
  demo = false,
  name,
  section = "Overview",
  sections = adminSections,
  roles = [],
}: {
  children: ReactNode;
  kind: "admin" | "counsellor";
  demo?: boolean;
  name: string;
  section?: string;
  sections?: readonly string[];
  roles?: Role[];
}) {
  if (kind === "admin" && !demo)
    return (
      <AdminShell
        active={destinationForSection(section)}
        name={name}
        roles={roles}
        title={TECHNICAL_TITLES[section] ?? section}
        technical={TECHNICAL_TITLES[section] ?? section}
        description="Technical workspace. Its forms call the same governed services as before."
      >
        <div className="ac-technical">{children}</div>
      </AdminShell>
    );
  const controlRoutes = demo ? [] : adminControlRoutesForRoles(roles);
  const base = demo ? "/demo/admin" : "/admin";
  return (
    <div className="staff-app">
      <header className="staff-top">
        <Brand />
        <div className="staff-top-links">
          <Link href={demo ? "/demo" : "/student"}>
            <ArrowLeft size={15} />
            Student academy
          </Link>
          <span className="staff-person">{name}</span>
          {!demo && (
            <form action={logout}>
              <button className="button secondary">Sign out</button>
            </form>
          )}
        </div>
      </header>
      <main id="main" tabIndex={-1} className="staff-main">
        <div className="page-heading">
          <div>
            <p className="eyebrow">
              {demo ? "DEMONSTRATION WORKSPACE" : "INSTITUTIONAL WORKSPACE"}
            </p>
            <h1>
              {kind === "admin"
                ? "Academy administration"
                : "Support, with continuity."}
            </h1>
            <p>
              {kind === "admin"
                ? "The foundations that keep your academy moving."
                : "Know your learners. Help them find their next step."}
            </p>
          </div>
          <Badge tone={demo ? "gold" : "green"}>
            {kind === "admin" ? (
              <ShieldCheck size={14} />
            ) : (
              <HeartHandshake size={14} />
            )}{" "}
            {demo ? "Read-only demo" : "Authorised staff"}
          </Badge>
        </div>
        {demo && (
          <div className="notice">
            This is a public preview with fictional records.{" "}
            <Link className="text-link" href="/login">
              Sign in for your authorised workspace →
            </Link>
          </div>
        )}
        {kind === "admin" && (
          <div className="staff-nav">
            <nav className="staff-tabs" aria-label="Administration sections">
              {controlRoutes.length > 0 && (
                <span className="staff-tabs-label">Academy records</span>
              )}
              {sections.map((s) => (
                <Link
                  key={s}
                  href={
                    base +
                    (s === "Overview" ? "" : "?section=" + s.toLowerCase())
                  }
                  className={s === section ? "selected" : ""}
                  aria-current={s === section ? "page" : undefined}
                >
                  {s}
                </Link>
              ))}
            </nav>
            {controlRoutes.length > 0 && (
              <nav
                className="staff-tabs"
                aria-label="Commercial V1 control plane"
              >
                <span className="staff-tabs-label">Control plane</span>
                {controlRoutes.map((route) => (
                  <Link
                    key={route.href}
                    href={route.href}
                    className={route.label === section ? "selected" : ""}
                    aria-current={route.label === section ? "page" : undefined}
                  >
                    {route.label}
                  </Link>
                ))}
              </nav>
            )}
          </div>
        )}
        {children}
        <footer className="staff-footer">
          DUCELIO · Institutional records stay with the academy. Support stays
          with the learner.
        </footer>
      </main>
    </div>
  );
}
