import { Badge } from "./ui";
import { SARAH_PERSONA } from "@/domain/sarah";

// AC-5: Sarah Mitchell's one learner-facing identity, shared by the signed-in
// guide and the demo preview so the persona stays consistent. She is
// presented as Ducelio's AI learner-success counsellor: never as a human
// member of staff, an assigned counsellor, a teacher or a therapist.
export function SarahIdentity({ as = "h2" }: { as?: "h1" | "h2" | "h3" }) {
  const Heading = as;
  return (
    <div className="counsellor-person">
      <div className="avatar counsellor-avatar" aria-hidden="true">
        {SARAH_PERSONA.initials}
      </div>
      <div>
        <Heading>{SARAH_PERSONA.name}</Heading>
        <span className="muted">{SARAH_PERSONA.title}</span>{" "}
        <Badge tone="muted">AI</Badge>
      </div>
    </div>
  );
}

export const SARAH_IS_AI_NOTICE =
  "Sarah is AI. She is not a human member of staff and not your assigned counsellor.";
