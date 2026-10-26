"use client";

import { useId, useState, useTransition } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react";
import {
  OPERATION_ACTIONS,
  operationActionIds,
  type FieldSpec,
  type OperationActionId,
} from "@/domain/operations-engineer";
import type {
  InterpretResult,
  Link as OperationLink,
  OperationOptions,
  PrepareResult,
  Proposal,
  Receipt,
} from "@/server/operations-engineer";
import {
  executeOperationAction,
  interpretRequestAction,
  prepareOperationAction,
  type ActionError,
} from "@/app/admin/operations-engineer/actions";

type Outcome =
  | { kind: "prepared"; result: PrepareResult; explanation?: string }
  | { kind: "receipt"; receipt: Receipt }
  | { kind: "message"; tone: "info" | "error"; text: string }
  | null;

const isError = (v: unknown): v is ActionError =>
  typeof v === "object" &&
  v !== null &&
  ["FORBIDDEN", "ERROR"].includes((v as { status: string }).status);

const READS = operationActionIds.filter(
  (id) => OPERATION_ACTIONS[id].kind === "READ",
);
const CHANGES = operationActionIds.filter(
  (id) => OPERATION_ACTIONS[id].kind === "MUTATION",
);

// Fields shown only for the chosen discount kind.
function hiddenField(id: OperationActionId, name: string, kind?: string) {
  if (id !== "create_coupon") return false;
  if (name === "percentOff") return kind !== "PERCENT";
  if (name === "amountOff" || name === "currency") return kind !== "AMOUNT";
  return false;
}

// The attached file travels to the server only, inside FormData.
function upload(file: File | null) {
  if (!file) return undefined;
  const data = new FormData();
  data.set("package", file);
  return data;
}

export function OperationsEngineerConsole({
  options,
  aiConfigured,
  initialAction,
  initialValues,
}: {
  options: OperationOptions;
  aiConfigured: boolean;
  initialAction?: OperationActionId;
  initialValues?: Record<string, string>;
}) {
  const [actionId, setActionId] = useState<OperationActionId>(
    initialAction ?? "list_courses",
  );
  const [file, setFile] = useState<File | null>(null);
  const [values, setValues] = useState<Record<string, string>>(
    initialValues ?? {},
  );
  const [request, setRequest] = useState("");
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [activity, setActivity] = useState<Receipt[]>([]);
  const [pending, start] = useTransition();
  const def = OPERATION_ACTIONS[actionId];
  const formId = useId();

  function choose(id: OperationActionId) {
    setActionId(id);
    setOutcome(null);
    setConfirmed(false);
  }

  function prepare(id: OperationActionId, raw: Record<string, string>) {
    setConfirmed(false);
    start(async () => {
      const result = await prepareOperationAction(
        id,
        raw,
        id === "upload_course_package" ? upload(file) : undefined,
      );
      setOutcome(
        isError(result)
          ? { kind: "message", tone: "error", text: result.message }
          : { kind: "prepared", result },
      );
    });
  }

  function interpret() {
    setConfirmed(false);
    start(async () => {
      const result: InterpretResult | ActionError =
        await interpretRequestAction(request);
      if (isError(result))
        return setOutcome({
          kind: "message",
          tone: "error",
          text: result.message,
        });
      if (
        result.status === "AI_NOT_CONFIGURED" ||
        result.status === "AI_FAILED"
      )
        return setOutcome({
          kind: "message",
          tone: "error",
          text: result.message,
        });
      if (result.status === "NO_ACTION")
        return setOutcome({
          kind: "message",
          tone: "info",
          text: `No governed operation matches this request. ${result.explanation}`,
        });
      setActionId(result.actionId);
      setValues(result.raw);
      setOutcome({
        kind: "prepared",
        result: result.prepared,
        explanation: result.explanation,
      });
    });
  }

  function execute(p: Proposal) {
    start(async () => {
      const receipt = await executeOperationAction(
        {
          actionId: p.actionId,
          raw: p.raw,
          issuedAt: p.issuedAt,
          nonce: p.nonce,
          proposalId: p.proposalId,
          confirmed: true,
        },
        p.actionId === "upload_course_package" ? upload(file) : undefined,
      );
      if (isError(receipt))
        return setOutcome({
          kind: "message",
          tone: "error",
          text: receipt.message,
        });
      setActivity((a) => [receipt, ...a].slice(0, 10));
      setOutcome({ kind: "receipt", receipt });
      setConfirmed(false);
    });
  }

  function discard() {
    setOutcome({
      kind: "message",
      tone: "info",
      text: "Proposal discarded. Nothing was changed.",
    });
    setConfirmed(false);
  }

  const missingChoices = def.fields.some(
    (f) => f.kind === "choice" && !f.optional && options[f.source].length === 0,
  );

  return (
    <div className="oe">
      <section className="ac-panel oe-ask" aria-labelledby="oe-ask-title">
        <div className="ac-panel-head">
          <div>
            <h2 id="oe-ask-title">
              <Sparkles size={18} aria-hidden="true" /> Ask in plain language
            </h2>
            <p className="ac-muted">
              The AI only interprets your request into one proposed operation.
              It cannot change anything; you confirm every change.
            </p>
          </div>
        </div>
        {!aiConfigured && (
          <p className="ac-note" role="status">
            AI interpretation is not configured in this deployment, so
            plain-language requests are unavailable. Every operation below works
            without AI.
          </p>
        )}
        <label htmlFor="oe-request" className="sr-only">
          Your request
        </label>
        <textarea
          id="oe-request"
          className="oe-request"
          rows={3}
          maxLength={2000}
          value={request}
          disabled={!aiConfigured}
          onChange={(e) => setRequest(e.target.value)}
          placeholder={
            aiConfigured
              ? "For example: why can't the AWS course be published yet?"
              : "Unavailable: AI interpretation is not configured."
          }
        />
        <button
          type="button"
          className="ac-button"
          disabled={!aiConfigured || pending || request.trim().length < 3}
          onClick={interpret}
        >
          {pending ? (
            <Loader2 size={16} className="oe-spin" aria-hidden="true" />
          ) : (
            <Sparkles size={16} aria-hidden="true" />
          )}
          {aiConfigured ? "Interpret request" : "AI not configured"}
        </button>
      </section>

      <section className="ac-panel" aria-labelledby="oe-pick-title">
        <div className="ac-panel-head">
          <div>
            <h2 id="oe-pick-title">Choose an operation</h2>
            <p className="ac-muted">
              Inspections run immediately and change nothing. Changes are
              prepared as a proposal for you to review.
            </p>
          </div>
        </div>
        <div className="oe-picker" role="radiogroup" aria-label="Operation">
          <p className="oe-group">Inspect</p>
          {READS.map((id) => (
            <ActionChip
              key={id}
              id={id}
              active={id === actionId}
              onSelect={choose}
            />
          ))}
          <p className="oe-group">Change</p>
          {CHANGES.map((id) => (
            <ActionChip
              key={id}
              id={id}
              active={id === actionId}
              onSelect={choose}
            />
          ))}
        </div>
        <form
          id={formId}
          className="oe-form"
          onSubmit={(e) => {
            e.preventDefault();
            prepare(actionId, values);
          }}
        >
          <h3>{def.title}</h3>
          <p className="ac-muted">{def.description}</p>
          {def.fields.map((f) => (
            <Field
              key={f.name}
              spec={f}
              value={values[f.name] ?? ""}
              options={f.kind === "choice" ? options[f.source] : []}
              onChange={(v) => setValues((old) => ({ ...old, [f.name]: v }))}
              onFile={(f) => {
                setFile(f);
                setOutcome(null);
                setConfirmed(false);
              }}
              hidden={hiddenField(actionId, f.name, values.discountKind)}
            />
          ))}
          {missingChoices && (
            <p className="ac-note">
              There is no eligible record for this operation right now.
            </p>
          )}
          <button
            className="ac-button"
            type="submit"
            disabled={pending || missingChoices}
          >
            {pending && (
              <Loader2 size={16} className="oe-spin" aria-hidden="true" />
            )}
            {def.kind === "READ" ? "Run inspection" : "Prepare proposal"}
          </button>
        </form>
      </section>

      <div aria-live="polite" className="oe-result">
        {outcome?.kind === "message" && (
          <p
            className={outcome.tone === "error" ? "ac-alert" : "ac-note"}
            role={outcome.tone === "error" ? "alert" : "status"}
          >
            {outcome.text}
          </p>
        )}
        {outcome?.kind === "prepared" && (
          <Prepared
            result={outcome.result}
            explanation={outcome.explanation}
            confirmed={confirmed}
            setConfirmed={setConfirmed}
            pending={pending}
            onExecute={execute}
            onDiscard={discard}
          />
        )}
        {outcome?.kind === "receipt" && (
          <ReceiptCard receipt={outcome.receipt} />
        )}
      </div>

      {activity.length > 0 && (
        <section className="ac-panel" aria-labelledby="oe-activity">
          <h2 id="oe-activity">This session&apos;s operations</h2>
          <ul className="oe-activity">
            {activity.map((r, i) => (
              <li key={`${r.reference}-${i}`}>
                <StatusIcon status={r.status} /> <strong>{r.title}</strong> —{" "}
                {r.outcome} <span className="ac-muted">ref {r.reference}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ActionChip({
  id,
  active,
  onSelect,
}: {
  id: OperationActionId;
  active: boolean;
  onSelect: (id: OperationActionId) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      className={active ? "oe-chip active" : "oe-chip"}
      onClick={() => onSelect(id)}
    >
      {OPERATION_ACTIONS[id].title}
    </button>
  );
}

function Field({
  spec,
  value,
  options,
  onChange,
  onFile,
  hidden,
}: {
  spec: FieldSpec;
  value: string;
  options: { value: string; label: string; warning?: string }[];
  onChange: (v: string) => void;
  onFile: (file: File | null) => void;
  hidden: boolean;
}) {
  const id = useId();
  if (hidden) return null;
  const help = "help" in spec ? spec.help : undefined;
  const selected = options.find((o) => o.value === value);
  return (
    <div className="field">
      <label htmlFor={id}>{spec.label}</label>
      {spec.kind === "file" ? (
        <input
          id={id}
          type="file"
          accept={spec.accept}
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        />
      ) : spec.kind === "choice" ? (
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={!spec.optional}
        >
          <option value="">{spec.optional?.label ?? "Choose…"}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
              {o.warning ? " ⚠" : ""}
            </option>
          ))}
        </select>
      ) : spec.kind === "select" ? (
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
        >
          <option value="">Choose…</option>
          {spec.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : spec.kind === "textarea" ? (
        <textarea
          id={id}
          value={value}
          maxLength={spec.maxLength}
          rows={2}
          required={!spec.optional}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : spec.kind === "integer" ? (
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={spec.min}
          max={spec.max}
          step={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
        />
      ) : spec.kind === "money" ? (
        <input
          id={id}
          inputMode="decimal"
          pattern="\d{1,7}(\.\d{1,2})?"
          placeholder="0.00"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
        />
      ) : spec.kind === "datetime" ? (
        <input
          id={id}
          type="datetime-local"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
        />
      ) : spec.kind === "text" ? (
        <input
          id={id}
          value={value}
          maxLength={spec.maxLength}
          onChange={(e) => onChange(e.target.value)}
          required={!spec.optional}
        />
      ) : null}
      {selected?.warning && (
        <small className="oe-warning">
          <AlertTriangle size={13} aria-hidden="true" /> {selected.warning}
        </small>
      )}
      {help && <small className="ac-muted">{help}</small>}
    </div>
  );
}

function Prepared({
  result,
  explanation,
  confirmed,
  setConfirmed,
  pending,
  onExecute,
  onDiscard,
}: {
  result: PrepareResult;
  explanation?: string;
  confirmed: boolean;
  setConfirmed: (v: boolean) => void;
  pending: boolean;
  onExecute: (p: Proposal) => void;
  onDiscard: () => void;
}) {
  const confirmId = useId();
  if (result.status === "INVALID")
    return (
      <div className="ac-alert" role="alert">
        <strong>Check the input:</strong>
        <ul>
          {result.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      </div>
    );
  if (result.status === "UNAVAILABLE")
    return (
      <p className="ac-alert" role="alert">
        {result.message}
      </p>
    );
  if (result.status === "READ_RESULT")
    return (
      <section className="ac-panel" aria-label={result.table.title}>
        {explanation && (
          <p className="oe-explanation">
            <Sparkles size={14} aria-hidden="true" /> {explanation}
          </p>
        )}
        <h2>{result.table.title}</h2>
        {result.table.rows.length === 0 ? (
          <p className="ac-muted">No records.</p>
        ) : (
          <div className="ac-table-wrap">
            <table className="ac-table">
              <thead>
                <tr>
                  {result.table.columns.map((c) => (
                    <th key={c} scope="col">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.table.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j} data-label={result.table.columns[j]}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result.table.summary && (
          <dl className="ac-dl oe-dl">
            {result.table.summary.map((d) => (
              <div key={d.label}>
                <dt>{d.label}</dt>
                <dd>{d.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {result.table.links && <Links links={result.table.links} />}
        {result.table.note && <p className="ac-muted">{result.table.note}</p>}
      </section>
    );
  const p = result.proposal;
  return (
    <section
      className="ac-panel oe-proposal"
      aria-labelledby="oe-proposal-title"
    >
      {explanation && (
        <p className="oe-explanation">
          <Sparkles size={14} aria-hidden="true" /> {explanation}
        </p>
      )}
      <p className="ac-eyebrow">PROPOSAL · NOT YET EXECUTED</p>
      <h2 id="oe-proposal-title">{p.title}</h2>
      <dl className="ac-dl oe-dl">
        {p.display.map((d) => (
          <div key={d.label}>
            <dt>{d.label}</dt>
            <dd>{d.value}</dd>
          </div>
        ))}
      </dl>
      <h3>Checks against the current records</h3>
      <ul className="oe-checks">
        {p.checks.map((c) => (
          <li
            key={c.text}
            className={c.ok ? "ok" : c.blocking ? "block" : "warn"}
          >
            {c.ok ? (
              <CheckCircle2 size={16} aria-hidden="true" />
            ) : c.blocking ? (
              <XCircle size={16} aria-hidden="true" />
            ) : (
              <AlertTriangle size={16} aria-hidden="true" />
            )}
            <span>
              <span className="sr-only">
                {c.ok ? "Passed: " : c.blocking ? "Blocking: " : "Warning: "}
              </span>
              {c.text}
            </span>
          </li>
        ))}
      </ul>
      {p.consequence && (
        <p>
          <strong>What changes:</strong> {p.consequence}
        </p>
      )}
      {p.duplicateProtection && (
        <p className="ac-muted">
          <strong>Duplicate protection:</strong> {p.duplicateProtection}
        </p>
      )}
      {p.recovery && (
        <p className="ac-muted">
          <strong>If you need to undo it:</strong> {p.recovery}
        </p>
      )}
      <p className="ac-muted">
        This proposal is valid until{" "}
        {new Date(p.expiresAt).toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
        })}{" "}
        and only while the checked records stay unchanged.
      </p>
      {p.blocked ? (
        <p className="ac-alert" role="alert">
          This operation cannot be executed until the blocking checks are
          resolved.
        </p>
      ) : (
        <label htmlFor={confirmId} className="oe-confirm">
          <input
            id={confirmId}
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          I have reviewed this exact operation and want to carry it out under my
          account.
        </label>
      )}
      <div className="oe-buttons">
        <button
          type="button"
          className="ac-button"
          disabled={p.blocked || !confirmed || pending}
          onClick={() => onExecute(p)}
        >
          {pending ? (
            <Loader2 size={16} className="oe-spin" aria-hidden="true" />
          ) : (
            <ShieldCheck size={16} aria-hidden="true" />
          )}
          {pending ? "Executing…" : "Confirm and execute"}
        </button>
        <button
          type="button"
          className="ac-button secondary"
          disabled={pending}
          onClick={onDiscard}
        >
          Discard proposal
        </button>
      </div>
    </section>
  );
}

function Links({ links }: { links: OperationLink[] }) {
  return (
    <ul className="oe-links">
      {links.map((l) => (
        <li key={l.href}>
          <a className="ac-link" href={l.href}>
            {l.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

function StatusIcon({ status }: { status: Receipt["status"] }) {
  return status === "SUCCEEDED" || status === "ALREADY_DONE" ? (
    <CheckCircle2 size={16} aria-hidden="true" className="oe-good" />
  ) : (
    <XCircle size={16} aria-hidden="true" className="oe-bad" />
  );
}

const RECEIPT_TITLES: Record<Receipt["status"], string> = {
  SUCCEEDED: "Operation completed",
  ALREADY_DONE: "Already in place",
  FAILED: "Operation failed",
  STATE_CHANGED: "Not executed: records changed",
  EXPIRED: "Not executed: proposal expired",
  DUPLICATE: "Not executed again",
  REFUSED: "Not executed",
  UNCERTAIN: "Outcome not confirmed",
};

function ReceiptCard({ receipt: r }: { receipt: Receipt }) {
  const good = r.status === "SUCCEEDED" || r.status === "ALREADY_DONE";
  return (
    <section
      className={`ac-panel oe-receipt ${good ? "good" : "bad"}`}
      aria-labelledby="oe-receipt-title"
      role={good ? "status" : "alert"}
    >
      <p className="ac-eyebrow">
        OPERATIONAL RECEIPT · REF {r.reference.toUpperCase()}
      </p>
      <h2 id="oe-receipt-title">
        <StatusIcon status={r.status} /> {RECEIPT_TITLES[r.status]}: {r.title}
      </h2>
      <p>{r.outcome}</p>
      {r.verified !== null && (
        <p className={r.verified ? "oe-verified" : "ac-note"}>
          {r.verified ? (
            <CheckCircle2 size={14} aria-hidden="true" />
          ) : (
            <AlertTriangle size={14} aria-hidden="true" />
          )}{" "}
          {r.verification}
        </p>
      )}
      {r.display.length > 0 && (
        <dl className="ac-dl oe-dl">
          {r.display.map((d) => (
            <div key={d.label}>
              <dt>{d.label}</dt>
              <dd>{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {r.links && <Links links={r.links} />}
      {r.executedAt && (
        <p className="ac-muted">
          Executed {new Date(r.executedAt).toLocaleString("en-GB")} under your
          account. The change is recorded in the audit trail with reference{" "}
          {r.reference}.
        </p>
      )}
      {r.recovery && (
        <p className="ac-muted">
          <strong>Recovery:</strong> {r.recovery}
        </p>
      )}
    </section>
  );
}
