"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  BookOpen,
  CalendarDays,
  Video,
  ClipboardList,
  FileCheck2,
  NotebookPen,
  ChartNoAxesCombined,
  HeartHandshake,
  UserRound,
  Bell,
  ArrowUpRight,
  Menu,
  LogOut,
  GraduationCap,
  ShieldCheck,
  Trophy,
  Award,
  MessageCircle,
  Compass,
} from "lucide-react";
import { Brand } from "./ui";
import { logout } from "@/app/auth/actions";
import type { ReactNode } from "react";
import type { Role } from "@/domain/academy";
const links = [
  ["Home", "", Home],
  ["Programme", "programme", BookOpen],
  ["Academy courses", "academy", GraduationCap],
  ["Calendar", "calendar", CalendarDays],
  ["Classes", "classes", Video],
  ["Assignments", "assignments", ClipboardList],
  ["Practicals", "practicals", ClipboardList],
  ["Leaderboard", "leaderboard", Trophy],
  ["Assessments", "assessments", FileCheck2],
  ["Course completion", "progress", Award],
  ["Notes", "notes", NotebookPen],
  ["Results", "results", ChartNoAxesCombined],
  ["Support", "support", HeartHandshake],
  // AC-5: Sarah Mitchell, Ducelio's AI learner-success counsellor.
  ["Sarah (AI guide)", "sarah", MessageCircle],
  ["Profile", "profile", UserRound],
] as const;
export function AcademyShell({
  children,
  demo = false,
  name = "Alex Morgan",
  roles = [],
}: {
  children: ReactNode;
  demo?: boolean;
  name?: string;
  roles?: Role[];
}) {
  const pathname = usePathname();
  const base = demo ? "/demo" : "/student";
  const active = links.find(
    ([, slug]) => pathname === (slug ? base + "/" + slug : base),
  );
  // Pages outside the main navigation still name themselves truthfully
  // rather than all reading as "Study plan".
  const current =
    active?.[0] ??
    (pathname.endsWith("/notifications")
      ? "Notifications"
      : pathname.endsWith("/lecture")
        ? "Lecture Hall"
        : pathname.startsWith(base + "/classroom/")
          ? "Classroom"
          : pathname === base + "/tutor-notes"
            ? "Tutor notes"
            : pathname === base + "/study-plan"
              ? "Study plan"
              : pathname === base + "/announcements"
                ? "Announcements"
                : "My academy");
  const initials = name
    .split(" ")
    .slice(0, 2)
    .map((n) => n[0])
    .join("");
  const nav = (
    <>
      {links
        .filter(
          ([, slug]) =>
            !demo ||
            (slug !== "practicals" &&
              slug !== "academy" &&
              slug !== "leaderboard" &&
              slug !== "progress" &&
              // The credential-free demo never reaches the governed Sarah
              // execution plane.
              slug !== "sarah"),
        )
        .map(([label, slug, Icon]) => {
          const href = slug ? base + "/" + slug : base;
          return (
            <Link
              key={label}
              className={pathname === href ? "nav-link active" : "nav-link"}
              href={href}
              aria-current={pathname === href ? "page" : undefined}
              onClick={(e) =>
                e.currentTarget.closest("details")?.removeAttribute("open")
              }
            >
              <Icon size={18} strokeWidth={1.7} />
              {label}
              {label === "Support" && <span className="nav-dot" />}
            </Link>
          );
        })}
      {/* The one public catalogue, shared with the homepage. Browsing needs
          no cohort assignment; enrolment keeps its own checkout rules. */}
      <Link
        className="nav-link"
        href="/courses"
        onClick={(e) =>
          e.currentTarget.closest("details")?.removeAttribute("open")
        }
      >
        <Compass size={18} strokeWidth={1.7} />
        Browse courses
      </Link>
    </>
  );
  return (
    <div className="academy">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">YOUR ACADEMY</div>
        <nav aria-label="Academy navigation">{nav}</nav>
        <div className="sidebar-bottom">
          <Link href={base + "/study-plan"} className="sidebar-plan">
            <GraduationCap size={23} />
            <strong>A little progress, every day.</strong>
            <span>
              Open your study plan <ArrowUpRight size={14} />
            </span>
          </Link>
          {(demo ||
            roles.some((r) =>
              ["ACADEMIC_ADMIN", "REGISTRAR", "PLATFORM_ADMIN"].includes(r),
            )) && (
            <Link className="staff-link" href={demo ? "/demo/admin" : "/admin"}>
              <ShieldCheck size={16} />
              Administration {demo && <small>Preview</small>}
            </Link>
          )}
          {(demo || roles.includes("COUNSELLOR")) && (
            <Link
              className="staff-link"
              href={demo ? "/demo/counsellor" : "/support"}
            >
              <HeartHandshake size={16} />
              Counsellor workspace
            </Link>
          )}
          <div className="sidebar-foot">
            <span className="academy-dot" />
            Your ambition. Guided to mastery.
          </div>
        </div>
      </aside>
      <div className="academy-content">
        <header className="topbar">
          <div className="mobile-brand">
            <Brand />
          </div>
          <div className="breadcrumb">
            My academy <span>/</span> <strong>{current}</strong>
          </div>
          <div className="topbar-actions">
            <span className="term-label">
              {demo ? "SEPTEMBER 2026" : "MY ACADEMY"}
            </span>
            <Link
              className="icon-link"
              aria-label={
                demo ? "Academy announcements" : "Academy notifications"
              }
              href={demo ? base + "/announcements" : base + "/notifications"}
            >
              <Bell size={19} />
            </Link>
            <Link
              href={base + "/profile"}
              className="avatar small"
              aria-label="Your profile"
            >
              {initials}
            </Link>
            {!demo && (
              <form action={logout}>
                <button className="icon-link" aria-label="Sign out">
                  <LogOut size={18} />
                </button>
              </form>
            )}
          </div>
        </header>
        <details className="mobile-menu">
          <summary>
            <Menu size={18} />
            Academy menu
            <span>{current}</span>
          </summary>
          <nav aria-label="Mobile academy navigation">
            {nav}
            {!demo && (
              <Link className="nav-link" href="/student/notifications">
                <Bell size={18} strokeWidth={1.7} />
                Notifications
              </Link>
            )}
            <Link className="nav-link" href={base + "/study-plan"}>
              Study plan
            </Link>
            {demo && (
              <Link className="nav-link" href="/demo/admin">
                Admin preview
              </Link>
            )}
          </nav>
        </details>
        {demo && (
          <div className="demo-banner">
            <span>
              <strong>DEMO ACADEMY</strong>
              <span className="banner-detail">
                Fictional records · illustrative academic content
              </span>
            </span>
            <Link href="/login">
              Sign in to your academy <ArrowUpRight size={14} />
            </Link>
          </div>
        )}
        <main id="main" tabIndex={-1} className="workspace">
          {children}
        </main>
        <footer className="workspace-footer">
          <span>© 2026 Ducelio</span>
          <span>Preparing you for external qualifications.</span>
        </footer>
      </div>
    </div>
  );
}
