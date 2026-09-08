import Link from "next/link";
import { ArrowLeft, ShieldCheck, HeartHandshake } from "lucide-react";
import { Brand, Badge } from "./ui";
import { logout } from "@/app/auth/actions";
import type { ReactNode } from "react";
export const adminSections = [
  "Overview",
  "Programmes",
  "Students",
  "Cohorts",
  "Counsellors",
  "Sessions",
  "Assignments",
  "Assessments",
  "Announcements",
  "Registry",
  "Audit",
];
export function StaffShell({
  children,
  kind,
  demo = false,
  name,
  section = "Overview",
}: {
  children: ReactNode;
  kind: "admin" | "counsellor";
  demo?: boolean;
  name: string;
  section?: string;
}) {
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
      <main id="main" className="staff-main">
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
          <nav className="staff-tabs" aria-label="Administration sections">
            {adminSections.map((s) => (
              <Link
                key={s}
                href={
                  base + (s === "Overview" ? "" : "?section=" + s.toLowerCase())
                }
                className={s === section ? "selected" : ""}
                aria-current={s === section ? "page" : undefined}
              >
                {s}
              </Link>
            ))}
          </nav>
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
