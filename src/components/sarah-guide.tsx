"use client";
import { useActionState } from "react";
import { Badge, Card, EmptyState } from "./ui";
import {
  PROPOSAL_FIELDS,
  PROPOSAL_FIELD_LABEL,
  SARAH_MESSAGE_MAX,
  SARAH_PERSONA,
  SARAH_PROPOSAL_MESSAGE,
  SARAH_STATUS_MESSAGE,
  type LearnerSarahProposal,
  type ProposalField,
  type SupportProfileView,
} from "@/domain/sarah";
import {
  askSarahAction,
  decideSarahProposalAction,
  type SarahActionState,
  type SarahDecisionState,
} from "@/app/student/sarah/actions";

export type SarahPanelState = {
  result: SarahActionState;
  idempotencyKey: string;
};

// The next panel state after one submission (independent review,
// Correction 7). Every resolved response, including DUPLICATE, rotates to a
// fresh key for the learner's NEXT deliberate message. Only an unresolved
// outcome (the request itself failed in transport) keeps the key, so a
// retry of that same request stays a safe duplicate. Rotation happens here,
// in the action result, never during render.
export async function submitSarahMessage(
  previous: SarahPanelState,
  form: FormData,
  send: (
    previous: SarahActionState,
    form: FormData,
  ) => Promise<SarahActionState> = askSarahAction,
  newKey: () => string = () => crypto.randomUUID(),
): Promise<SarahPanelState> {
  try {
    const result = await send(previous.result, form);
    return { result, idempotencyKey: newKey() };
  } catch {
    return {
      result: { status: "RETRY_LATER" },
      idempotencyKey: previous.idempotencyKey,
    };
  }
}

// AC-5: asking Sarah Mitchell. The learner chooses only what they need (two
// fixed options) and writes a message; nothing else is sent. Sarah's reply
// is rendered as React text, never HTML, and is not saved anywhere. The
// first idempotency key comes from the Server Component, so server render
// and hydration agree.
export function SarahAskPanel({
  initialIdempotencyKey,
}: {
  initialIdempotencyKey: string;
}) {
  const [panel, formAction, pending] = useActionState<
    SarahPanelState,
    FormData
  >((previous, form) => submitSarahMessage(previous, form), {
    result: {},
    idempotencyKey: initialIdempotencyKey,
  });
  const state = panel.result;
  const idempotencyKey = panel.idempotencyKey;
  return (
    <Card>
      <h2>Ask Sarah</h2>
      <form action={formAction}>
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        <fieldset disabled={pending}>
          <legend>What would you like help with?</legend>
          <label className="engineering-checkbox">
            <input type="radio" name="intent" value="GUIDE" defaultChecked />
            Getting started, finding my way around Ducelio, or my schedule and
            support information
          </label>
          <label className="engineering-checkbox">
            <input type="radio" name="intent" value="SUPPORT_PROFILE" />
            Suggesting an update to my support preferences (study goal, weekly
            study hours or preferred contact)
          </label>
        </fieldset>
        <label>
          Your message
          <textarea
            name="message"
            maxLength={SARAH_MESSAGE_MAX}
            minLength={1}
            required
            rows={4}
            disabled={pending}
          />
        </label>
        <button className="button" disabled={pending}>
          {pending ? "Sarah is replying…" : "Send to Sarah"}
        </button>
        <p className="config-caption">
          Sarah answers each message on its own and does not remember earlier
          messages. Your message and her reply are not saved.
        </p>
      </form>
      <div aria-live="polite">
        {state.error && <p role="alert">{state.error}</p>}
        {state.status && state.status !== "SUCCEEDED" && (
          <p role="status">{SARAH_STATUS_MESSAGE[state.status]}</p>
        )}
        {state.status === "SUCCEEDED" && state.reply && (
          <div className="support-record">
            <h3>{SARAH_PERSONA.name} (AI)</h3>
            <p style={{ whiteSpace: "pre-wrap" }}>{state.reply}</p>
            {state.proposal && state.proposal !== "NONE" && (
              <p role="status">{SARAH_PROPOSAL_MESSAGE[state.proposal]}</p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function displayValue(
  field: ProposalField,
  value: string | number | null | undefined,
): string {
  if (value === null || value === undefined || value === "") return "Not set";
  if (field === "weeklyHours") return `${value} hours a week`;
  if (field === "preferredContact")
    return value === "EMAIL" ? "Email" : "In the academy";
  return String(value);
}

const DECISION_MESSAGE: Record<
  NonNullable<SarahDecisionState["outcome"]>,
  string
> = {
  CONFIRMED: "Your support preferences were updated with this change.",
  DECLINED: "Suggestion declined. Nothing changed.",
  STALE:
    "Your support preferences changed after Sarah made this suggestion, so it was not applied. Nothing changed.",
  ALREADY_DECIDED: "This suggestion was already decided.",
  UNAVAILABLE: "This could not be completed. Nothing changed.",
};

const STATE_LABEL: Record<LearnerSarahProposal["state"], string> = {
  PENDING: "Waiting for your decision",
  CONFIRMED: "Confirmed by you",
  DECLINED: "Declined by you",
  STALE: "Out of date: not applied",
};

function ProposalCard({
  proposal,
  current,
}: {
  proposal: LearnerSarahProposal;
  current: SupportProfileView;
}) {
  const [state, formAction, pending] = useActionState<
    SarahDecisionState,
    FormData
  >(decideSarahProposalAction, {});
  const fields = PROPOSAL_FIELDS.filter((f) => proposal[f] !== null);
  const open = proposal.state === "PENDING" && !state.outcome;
  return (
    <article className="support-record" aria-label="Suggested change">
      <Badge tone={proposal.state === "PENDING" ? "gold" : "muted"}>
        {STATE_LABEL[proposal.state].toUpperCase()}
      </Badge>
      <p className="muted">
        Suggested by {SARAH_PERSONA.name} (AI) on{" "}
        {new Date(proposal.createdAt).toLocaleString()}
      </p>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Preference</th>
              {proposal.state === "PENDING" && (
                <th scope="col">Confirmed now</th>
              )}
              <th scope="col">Suggested</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => (
              <tr key={field}>
                <th scope="row">{PROPOSAL_FIELD_LABEL[field]}</th>
                {proposal.state === "PENDING" && (
                  <td>{displayValue(field, current[field])}</td>
                )}
                <td>{displayValue(field, proposal[field])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && proposal.stale && (
        <p>
          Your support preferences changed after this suggestion, so it can no
          longer be applied. You can decline it.
        </p>
      )}
      {open && (
        <form action={formAction}>
          <input type="hidden" name="proposalId" value={proposal.id} />
          {!proposal.stale && (
            <button
              className="button"
              name="decision"
              value="CONFIRM"
              disabled={pending}
            >
              Confirm this change
            </button>
          )}{" "}
          <button
            className="button secondary"
            name="decision"
            value="DECLINE"
            disabled={pending}
          >
            Decline
          </button>
        </form>
      )}
      {state.outcome && <p role="status">{DECISION_MESSAGE[state.outcome]}</p>}
    </article>
  );
}

// Sarah's suggestions are optional and never applied automatically. The
// current confirmed value and the suggested value are shown side by side,
// and only the learner's explicit confirmation changes anything.
export function SarahProposals({
  current,
  proposals,
}: {
  current: SupportProfileView;
  proposals: LearnerSarahProposal[];
}) {
  return (
    <Card>
      <h2>Suggested changes to your support preferences</h2>
      <p>
        These are optional suggestions from Sarah, based only on what you told
        her. Nothing changes unless you confirm. Sarah cannot confirm a
        suggestion for you.
      </p>
      <h3>Your confirmed support preferences</h3>
      <dl className="profile-list">
        {PROPOSAL_FIELDS.map((field) => (
          <div key={field}>
            <dt>{PROPOSAL_FIELD_LABEL[field]}</dt>
            <dd>{displayValue(field, current[field])}</dd>
          </div>
        ))}
      </dl>
      {proposals.length === 0 ? (
        <EmptyState title="No suggestions">
          Ask Sarah to suggest an update to your support preferences, and any
          suggestion will appear here for you to confirm or decline.
        </EmptyState>
      ) : (
        proposals.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            current={current}
          />
        ))
      )}
    </Card>
  );
}
