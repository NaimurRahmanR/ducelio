import Link from "next/link";
import type { ReactNode } from "react";
import {
  LayoutDashboard,
  BookOpenCheck,
  Bot,
  ReceiptText,
  GraduationCap,
  Menu,
  LogOut,
  ArrowLeft,
  ChevronRight,
} from "lucide-react";
import { Brand } from "./ui";
import { logout } from "@/app/auth/actions";
import type { Role } from "@/domain/academy";

// One course workspace, with separate protected historical operations.
// The menu only aids discovery; every page enforces its own roles on the
// server and the database enforces them again.
export type Destination =
  "dashboard" | "courses" | "operations" | "sales" | "academy";

const COURSE_ADMIN: readonly Role[] = ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"];
const ANY_ADMIN: readonly Role[] = [
  "ACADEMIC_ADMIN",
  "REGISTRAR",
  "PLATFORM_ADMIN",
];

export const ADMIN_DESTINATIONS = [
  {
    id: "dashboard",
    label: "Dashboard",
    href: "/admin",
    icon: LayoutDashboard,
    roles: ANY_ADMIN,
  },
  {
    id: "courses",
    label: "Course Engineering",
    href: "/admin/course-engineering",
    icon: BookOpenCheck,
    roles: COURSE_ADMIN,
  },
  {
    id: "sales",
    label: "Sales & Commerce",
    href: "/admin/sales",
    icon: ReceiptText,
    roles: COURSE_ADMIN,
  },
  {
    id: "academy",
    label: "Historical academic records",
    href: "/admin/academy",
    icon: GraduationCap,
    roles: ANY_ADMIN,
  },
] as const satisfies readonly {
  id: Destination;
  label: string;
  href: string;
  icon: typeof LayoutDashboard;
  roles: readonly Role[];
}[];

export function destinationsForRoles(roles: readonly Role[]) {
  return ADMIN_DESTINATIONS.filter((d) =>
    d.roles.some((role) => roles.includes(role)),
  );
}

// Where each pre-existing technical route belongs.
const TECHNICAL_HOME: Record<string, Destination> = {
  "Course Engineering": "courses",
  Activation: "courses",
  "Policy setup": "courses",
  Cohorts: "courses",
  Commerce: "sales",
  Agents: "academy",
  People: "academy",
  "Academic review": "academy",
  "Academic results": "academy",
  "Grade recovery": "academy",
};
export const destinationForSection = (section: string): Destination =>
  TECHNICAL_HOME[section] ?? "academy";

function Nav({
  roles,
  active,
  label,
}: {
  roles: readonly Role[];
  active: Destination;
  label: string;
}) {
  return (
    <nav aria-label={label} className="ac-nav">
      {destinationsForRoles(roles).map((d) => {
        const Icon = d.icon;
        const current = d.id === active;
        return (
          <Link
            key={d.id}
            href={d.href}
            className={current ? "ac-nav-link active" : "ac-nav-link"}
            aria-current={current ? "page" : undefined}
          >
            <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
            {d.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function AdminShell({
  children,
  active,
  name,
  roles,
  title,
  description,
  actions,
  technical,
}: {
  children: ReactNode;
  active: Destination;
  name: string;
  roles: readonly Role[];
  title: string;
  description?: string;
  actions?: ReactNode;
  // Set for the pre-existing technical routes rendered inside the shell.
  technical?: string;
}) {
  const home = ADMIN_DESTINATIONS.find((d) => d.id === active)!;
  const initials = name
    .split(" ")
    .slice(0, 2)
    .map((n) => n[0])
    .join("");
  const courseAdmin = roles.some((r) => COURSE_ADMIN.includes(r));
  return (
    <div className="ac-app">
      <aside className="ac-sidebar">
        <div className="ac-brand">
          <Brand />
        </div>
        <p className="ac-sidebar-label">CONTROL CENTRE</p>
        <Nav roles={roles} active={active} label="Administration" />
        <div className="ac-sidebar-foot">
          <Link href="/" className="ac-sidebar-link">
            <ArrowLeft size={15} aria-hidden="true" /> Public website
          </Link>
          <p>Governed operations. Every change is audited.</p>
        </div>
      </aside>
      <div className="ac-body">
        <header className="ac-topbar">
          <details className="ac-mobile-menu">
            <summary>
              <Menu size={18} aria-hidden="true" />
              <span>Menu</span>
            </summary>
            <Nav roles={roles} active={active} label="Administration menu" />
          </details>
          <div className="ac-mobile-brand">
            <Brand />
          </div>
          <nav aria-label="Breadcrumb" className="ac-breadcrumb">
            <Link href={home.href}>{home.label}</Link>
            {technical && (
              <>
                <ChevronRight size={14} aria-hidden="true" />
                <span>{technical}</span>
              </>
            )}
          </nav>
          <div className="ac-topbar-actions">
            {courseAdmin && active !== "operations" && (
              <Link
                href="/admin/operations-engineer"
                className="ac-ask"
                aria-label="Ask the Operations Engineer"
              >
                <Bot size={16} aria-hidden="true" />
                <span>Ask Operations Engineer</span>
              </Link>
            )}
            <span className="ac-avatar" title={name} aria-hidden="true">
              {initials}
            </span>
            <span className="ac-user">{name}</span>
            <form action={logout}>
              <button className="ac-icon-button" aria-label="Sign out">
                <LogOut size={17} aria-hidden="true" />
              </button>
            </form>
          </div>
        </header>
        <main id="main" tabIndex={-1} className="ac-content">
          <div className="ac-page-head">
            <div>
              {technical && (
                <Link href={home.href} className="ac-back">
                  <ArrowLeft size={14} aria-hidden="true" /> Back to{" "}
                  {home.label}
                </Link>
              )}
              <h1>{title}</h1>
              {description && <p>{description}</p>}
            </div>
            {actions && <div className="ac-page-actions">{actions}</div>}
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}

const ROLE_NAMES: Partial<Record<Role, string>> = {
  ACADEMIC_ADMIN: "academic administrator",
  PLATFORM_ADMIN: "platform administrator",
  REGISTRAR: "registrar",
};

// Rendered when a signed-in administrator opens a workspace their roles do
// not cover. Nothing behind the workspace has been read.
export function AdminForbidden({
  actor,
  active,
  title,
  requires,
}: {
  actor: { displayName: string; roles: readonly Role[] };
  active: Destination;
  title: string;
  requires: readonly Role[];
}) {
  return (
    <AdminShell
      active={active}
      name={actor.displayName}
      roles={actor.roles}
      title={title}
    >
      <section className="ac-panel" aria-labelledby="forbidden-title">
        <h2 id="forbidden-title">You do not have access to this workspace</h2>
        <p role="alert">
          {title} requires the{" "}
          {requires.map((r) => ROLE_NAMES[r] ?? r).join(" or ")} role. No
          records from it were loaded.
        </p>
        <p className="ac-muted">
          Ask a platform administrator if your work needs this access.
        </p>
        <Link href="/admin" className="ac-button secondary">
          Back to the dashboard
        </Link>
      </section>
    </AdminShell>
  );
}
