import type { Role } from "./academy";

// Academy Operations tabs: existing protected workspaces organised by what
// an operator is doing. Sections keep their per-role availability.
export type AcademyTab = {
  id: string;
  label: string;
  intro: string;
  sections: string[];
  links: { label: string; href: string; description: string; roles: Role[] }[];
};

const COURSE_ADMIN: Role[] = ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"];

// Existing protected workspaces, organised by what an operator is doing.
// Sections keep their per-role availability from adminSectionsForRoles.
export const ACADEMY_TABS: AcademyTab[] = [
  {
    id: "learners",
    label: "Learners & enrolments",
    intro:
      "Enrol learners into cohorts, assign counsellors, correct official records and manage notifications.",
    sections: ["Students", "Counsellors", "Registry", "Notifications"],
    links: [],
  },
  {
    id: "assessments",
    label: "Assessments & results",
    intro:
      "Assessment and assignment records, learning evidence, academic review and published results.",
    sections: ["Assessments", "Assignments", "Evidence"],
    links: [
      {
        label: "Academic review",
        href: "/admin/academic-review",
        description: "Review escalated and flagged Examiner outcomes.",
        roles: COURSE_ADMIN,
      },
      {
        label: "Academic results",
        href: "/admin/academic-results",
        description: "Course results, completion and result publication.",
        roles: COURSE_ADMIN,
      },
      {
        label: "Examiner grade recovery",
        href: "/admin/activation/recovery",
        description: "Recover Examiner grading that did not complete.",
        roles: COURSE_ADMIN,
      },
    ],
  },
  {
    id: "teaching",
    label: "Teaching & scheduling",
    intro:
      "Class sessions, attendance, lesson progress, learning resources and programme versions.",
    sections: ["Sessions", "Resources", "Programmes"],
    links: [
      {
        label: "Cohorts",
        href: "/admin/cohorts",
        description: "Create cohorts and manage their lifecycle and roster.",
        roles: COURSE_ADMIN,
      },
    ],
  },
  {
    id: "agents",
    label: "AI agents & health",
    intro:
      "Which reviewed AI runtime profiles are configured, and each course version's agent settings.",
    sections: [],
    links: [
      {
        label: "AI agent configuration",
        href: "/admin/agents",
        description:
          "Per-course agent settings, runtime profiles, budgets and evidence.",
        roles: COURSE_ADMIN,
      },
    ],
  },
  {
    id: "permissions",
    label: "Permissions & staff",
    intro: "Staff profiles, role grants, account status and the audit trail.",
    sections: ["Audit"],
    links: [
      {
        label: "People and roles",
        href: "/admin/people",
        description:
          "Create staff profiles, grant or revoke roles, and activate or deactivate accounts.",
        roles: ["PLATFORM_ADMIN"],
      },
    ],
  },
  {
    id: "organisations",
    label: "Organisations",
    intro: "Course-publishing organisations and their own administrators.",
    sections: [],
    links: [],
  },
];

const SECTION_TAB = new Map(
  ACADEMY_TABS.flatMap((t) => t.sections.map((s) => [s.toLowerCase(), t.id])),
);
export const tabForSection = (section: string) =>
  SECTION_TAB.get(section.toLowerCase()) ?? "learners";
