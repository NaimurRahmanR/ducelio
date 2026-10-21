import Link from "next/link";
import { SARAH_PERSONA } from "@/domain/sarah";
import { SARAH_IS_AI_NOTICE } from "./sarah-identity";

// The academy's named AI characters, shared by the public homepage and the
// signed-in dashboard so names, roles and descriptions never drift apart.
// Each one maps to a role that already runs in Ducelio: the classroom
// Professor, the practical Lab Instructor and Sarah, the AI learner guide
// (AC-5). Sarah's name and initials come from her one persona definition.
// Descriptions state only what those roles already do.
export const AI_LEARNING_TEAM = [
  {
    name: "Professor Atlas",
    role: "AI Professor",
    initials: "PA",
    summary:
      "Teaches your scheduled classes, lesson by lesson, to the course's published objectives.",
    href: "/student/classes",
    action: "Your classes",
  },
  {
    name: "Dr. Forge",
    role: "AI Lab Instructor",
    initials: "DF",
    summary:
      "Helps you work through hands-on practicals when you ask for support with a lab.",
    href: "/student/practicals",
    action: "Your practicals",
  },
  {
    name: SARAH_PERSONA.name,
    role: "AI Learner Guide",
    initials: SARAH_PERSONA.initials,
    summary:
      "Helps you get started, find your way around Ducelio and choose what to study next.",
    href: "/student/sarah",
    action: "Ask Sarah",
  },
] as const;

// Operational roles, explained without personal names. Only roles that exist
// in the academy today; the Registrar is a member of staff, not AI.
const ACADEMY_ROLES = [
  {
    role: "Q&A Tutor",
    kind: "AI",
    summary: "Answers your follow-up questions on a lesson's material.",
  },
  {
    role: "Examiner",
    kind: "AI",
    summary:
      "Marks written assessment answers and practical labs against the published marking rules.",
  },
  {
    role: "Registrar",
    kind: "Staff",
    summary: "Keeps official enrolment and academic records accurate.",
  },
] as const;

function Portrait({ initials }: { initials: string }) {
  return (
    <span className="ai-portrait" aria-hidden="true">
      {initials}
    </span>
  );
}

export function AiLearningTeam() {
  return (
    <section className="ai-team" aria-labelledby="ai-team-heading">
      <div className="ai-team-intro">
        <p className="ai-team-eyebrow">GUIDED BY AI, CLEARLY LABELLED</p>
        <h2 id="ai-team-heading">Meet your AI learning team</h2>
        <p>
          Three AI characters guide your course. Each one has a clear job, and
          AI help pauses automatically while a controlled assessment is in
          progress.
        </p>
      </div>
      <ul className="ai-team-grid">
        {AI_LEARNING_TEAM.map((member) => (
          <li key={member.name} className="ai-member">
            <Portrait initials={member.initials} />
            <h3>{member.name}</h3>
            <p className="ai-member-role">
              {member.role} <span className="ai-tag">AI</span>
            </p>
            <p>{member.summary}</p>
          </li>
        ))}
      </ul>
      <p className="ai-team-note">{SARAH_IS_AI_NOTICE}</p>
      <dl className="ai-roles" aria-label="Other academy roles">
        {ACADEMY_ROLES.map((item) => (
          <div key={item.role}>
            <dt>
              {item.role}{" "}
              <span
                className={
                  item.kind === "AI" ? "ai-tag" : "ai-tag ai-tag-staff"
                }
              >
                {item.kind}
              </span>
            </dt>
            <dd>{item.summary}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// The signed-in dashboard's compact introduction. Each link goes to a page
// the learner already has; nothing here starts a session with an AI.
export function AiLearningTeamCard() {
  return (
    <section
      className="card ai-team-card"
      aria-labelledby="ai-team-card-heading"
    >
      <h2 id="ai-team-card-heading">Your AI learning team</h2>
      <ul>
        {AI_LEARNING_TEAM.map((member) => (
          <li key={member.name}>
            <Portrait initials={member.initials} />
            <div>
              <h3>
                {member.name} <span className="ai-tag">AI</span>
              </h3>
              <p className="muted">
                {member.role}. {member.summary}
              </p>
              <Link href={member.href} className="ai-team-link">
                {member.action} <span aria-hidden="true">→</span>
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
