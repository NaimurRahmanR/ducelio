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
  Compass,
  LayoutDashboard,
  MessageCircle,
  Archive,
  LifeBuoy,
  type LucideIcon,
} from "lucide-react";
import { Brand } from "./ui";
import { logout } from "@/app/auth/actions";
import type { MouseEvent, ReactNode } from "react";
import type { Role } from "@/domain/academy";

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  // Further paths that belong to this item (for aria-current).
  also?: (pathname: string) => boolean;
};

// The signed-in learner's main navigation (docs/61 §2), exactly these six.
export const LEARNER_NAV: readonly NavItem[] = [
  { label: "Dashboard", href: "/student", icon: LayoutDashboard },
  {
    label: "My Learning",
    href: "/student/learning",
    icon: GraduationCap,
    also: (p) =>
      p.startsWith("/student/courses/") ||
      p === "/student/academy" ||
      p.startsWith("/student/academy/"),
  },
  { label: "My Timetable", href: "/student/timetable", icon: CalendarDays },
  {
    label: "Leaderboards",
    href: "/student/leaderboards",
    icon: Trophy,
    also: (p) => p === "/student/leaderboard",
  },
  { label: "Browse Courses", href: "/courses", icon: Compass },
  { label: "Profile", href: "/student/profile", icon: UserRound },
];

// The credential-free demo keeps its own fictional sections (/demo/*) and
// never reaches the governed Sarah execution plane.
const DEMO_NAV: readonly NavItem[] = [
  { label: "Home", href: "/demo", icon: Home },
  { label: "Programme", href: "/demo/programme", icon: BookOpen },
  { label: "Calendar", href: "/demo/calendar", icon: CalendarDays },
  { label: "Classes", href: "/demo/classes", icon: Video },
  { label: "Assignments", href: "/demo/assignments", icon: ClipboardList },
  { label: "Assessments", href: "/demo/assessments", icon: FileCheck2 },
  { label: "Notes", href: "/demo/notes", icon: NotebookPen },
  { label: "Results", href: "/demo/results", icon: ChartNoAxesCombined },
  { label: "Support", href: "/demo/support", icon: HeartHandshake },
  { label: "Profile", href: "/demo/profile", icon: UserRound },
  { label: "Browse Courses", href: "/courses", icon: Compass },
];

// Quiet secondary links for signed-in learners: Sarah's full page (her
// suggestions and session feedback live there) and earlier cohort
// programme records, which stay reachable but are not main navigation.
const LEARNER_SECONDARY: readonly NavItem[] = [
  { label: "Sarah (AI guide)", href: "/student/sarah", icon: MessageCircle },
  { label: "Academic records", href: "/student/programme", icon: Archive },
];

// Names for pages outside the main navigation, so every page names itself
// truthfully in the breadcrumb.
const PAGE_LABELS: Record<string, string> = {
  programme: "Academic records",
  calendar: "Calendar",
  classes: "Classes",
  assignments: "Assignments",
  practicals: "Practicals",
  leaderboard: "Leaderboards",
  assessments: "Assessments",
  progress: "Course completion",
  notes: "Notes",
  results: "Results",
  support: "Support & Feedback",
  sarah: "Sarah (AI guide)",
  notifications: "Notifications",
  "tutor-notes": "Tutor notes",
  "study-plan": "Study plan",
  announcements: "Announcements",
};

function isActive(item: NavItem, pathname: string) {
  return pathname === item.href || (item.also?.(pathname) ?? false);
}

function pageLabel(pathname: string, base: string, items: readonly NavItem[]) {
  const active = items.find((i) => isActive(i, pathname));
  if (active) return active.label;
  if (pathname.endsWith("/lecture")) return "Lecture Hall";
  if (pathname.startsWith(base + "/classroom/")) return "Classroom";
  const slug = pathname.startsWith(base + "/")
    ? pathname.slice(base.length + 1)
    : "";
  return PAGE_LABELS[slug] ?? "My academy";
}

const closeMenu = (e: MouseEvent<HTMLAnchorElement>) =>
  e.currentTarget.closest("details")?.removeAttribute("open");

function NavLinks({
  items,
  pathname,
}: {
  items: readonly NavItem[];
  pathname: string;
}) {
  return (
    <>
      {items.map((item) => {
        const active = isActive(item, pathname);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            className={active ? "nav-link active" : "nav-link"}
            href={item.href}
            aria-current={active ? "page" : undefined}
            onClick={closeMenu}
          >
            <Icon size={18} strokeWidth={1.7} aria-hidden="true" />
            {item.label}
          </Link>
        );
      })}
    </>
  );
}

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
  const items = demo ? DEMO_NAV : LEARNER_NAV;
  const current = pageLabel(pathname, base, [
    ...items,
    ...(demo ? [] : LEARNER_SECONDARY),
  ]);
  const supportHref = demo ? "/demo/support" : "/student/support";
  const initials = name
    .split(" ")
    .slice(0, 2)
    .map((n) => n[0])
    .join("");
  const staffLinks = (
    <>
      {(demo ||
        roles.some((r) =>
          ["ACADEMIC_ADMIN", "REGISTRAR", "PLATFORM_ADMIN"].includes(r),
        )) && (
        <Link className="staff-link" href={demo ? "/demo/admin" : "/admin"}>
          <ShieldCheck size={16} aria-hidden="true" />
          Administration {demo && <small>Preview</small>}
        </Link>
      )}
      {(demo || roles.includes("COUNSELLOR")) && (
        <Link
          className="staff-link"
          href={demo ? "/demo/counsellor" : "/support"}
        >
          <HeartHandshake size={16} aria-hidden="true" />
          Counsellor workspace
        </Link>
      )}
    </>
  );
  return (
    <div className="academy ln-shell">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">YOUR ACADEMY</div>
        <nav aria-label="Academy navigation">
          <NavLinks items={items} pathname={pathname} />
        </nav>
        <div className="sidebar-bottom">
          {demo ? (
            <Link href={base + "/study-plan"} className="sidebar-plan">
              <GraduationCap size={23} aria-hidden="true" />
              <strong>A little progress, every day.</strong>
              <span>
                Open your study plan <ArrowUpRight size={14} />
              </span>
            </Link>
          ) : (
            <nav aria-label="More academy links" className="ln-secondary-nav">
              {LEARNER_SECONDARY.map((item) => {
                const Icon = item.icon;
                const active = isActive(item, pathname);
                return (
                  <Link
                    key={item.href}
                    className="staff-link"
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon size={16} aria-hidden="true" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          )}
          {staffLinks}
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
              <Bell size={19} aria-hidden="true" />
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
                  <LogOut size={18} aria-hidden="true" />
                </button>
              </form>
            )}
          </div>
        </header>
        <details className="mobile-menu">
          <summary>
            <Menu size={18} aria-hidden="true" />
            Academy menu
            <span>{current}</span>
          </summary>
          <nav aria-label="Mobile academy navigation">
            <NavLinks items={items} pathname={pathname} />
            {!demo && (
              <>
                <NavLinks items={LEARNER_SECONDARY} pathname={pathname} />
                <Link
                  className="nav-link"
                  href="/student/notifications"
                  onClick={closeMenu}
                >
                  <Bell size={18} strokeWidth={1.7} aria-hidden="true" />
                  Notifications
                </Link>
              </>
            )}
            {demo && (
              <>
                <Link className="nav-link" href={base + "/study-plan"}>
                  Study plan
                </Link>
                <Link className="nav-link" href="/demo/admin">
                  Admin preview
                </Link>
              </>
            )}
          </nav>
          {!demo && <div className="ln-mobile-staff">{staffLinks}</div>}
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
          <Link
            className="ln-footer-link"
            href={supportHref}
            aria-current={pathname === supportHref ? "page" : undefined}
          >
            <LifeBuoy size={16} aria-hidden="true" />
            Support &amp; Feedback
          </Link>
          <span>Preparing you for external qualifications.</span>
        </footer>
      </div>
    </div>
  );
}
