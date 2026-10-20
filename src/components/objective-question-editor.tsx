"use client";

import { useActionState, useMemo, useState, type ReactNode } from "react";
import {
  addObjectiveQuestion,
  type AssessmentActionState,
} from "@/app/admin/actions";
import {
  OBJECTIVE_QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  SCORING_RULES,
  SCORING_RULE_DESCRIPTIONS,
  answerKeyIssues,
  interactionIssues,
  type ObjectiveQuestionType,
  type ScoringRule,
} from "@/domain/assessment-question-types";

// Identifiers are learner-visible (they travel with the interaction), so
// they are random and never encode position or correctness -- e.g. ordering
// steps are not numbered in their correct order.
function newId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return (
    "c" + Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("")
  ).slice(0, 12);
}

type Row = { id: string; label: string };
const row = (label = ""): Row => ({ id: newId(), label });
type Field = { id: string; label: string; options: Row[]; correct: string };

function Message({ state }: { state: AssessmentActionState }) {
  if (state.error)
    return (
      <p className="notice error" role="alert">
        {state.error}
      </p>
    );
  if (state.message)
    return (
      <p className="notice" role="status">
        {state.message}
      </p>
    );
  return null;
}

function RowList({
  legend,
  rows,
  min,
  max,
  onChange,
  renderExtra,
}: {
  legend: string;
  rows: Row[];
  min: number;
  max: number;
  onChange: (rows: Row[]) => void;
  renderExtra?: (row: Row, index: number) => ReactNode;
}) {
  return (
    <fieldset className="objective-editor-list">
      <legend>{legend}</legend>
      {rows.map((r, i) => (
        <div className="objective-editor-row" key={r.id}>
          <label className="sr-only" htmlFor={`label-${r.id}`}>
            {legend} {i + 1}
          </label>
          <input
            id={`label-${r.id}`}
            value={r.label}
            maxLength={500}
            placeholder={`${legend} ${i + 1}`}
            onChange={(e) =>
              onChange(
                rows.map((x) =>
                  x.id === r.id ? { ...x, label: e.target.value } : x,
                ),
              )
            }
          />
          {renderExtra?.(r, i)}
          <button
            type="button"
            className="button secondary"
            disabled={rows.length <= min}
            aria-label={`Remove ${legend.toLowerCase()} ${i + 1}`}
            onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button secondary"
        disabled={rows.length >= max}
        onClick={() => onChange([...rows, row()])}
      >
        Add {legend.toLowerCase()}
      </button>
    </fieldset>
  );
}

function ScoringRuleField({
  type,
  value,
  onChange,
}: {
  type: Exclude<ObjectiveQuestionType, "SINGLE_SELECT">;
  value: ScoringRule;
  onChange: (rule: ScoringRule) => void;
}) {
  return (
    <div className="field">
      <label htmlFor="objective-scoring-rule">
        Scoring rule (shown to learners)
      </label>
      <select
        id="objective-scoring-rule"
        value={value}
        onChange={(e) => onChange(e.target.value as ScoringRule)}
      >
        {SCORING_RULES[type].map((rule) => (
          <option key={rule} value={rule}>
            {rule.replaceAll("_", " ").toLowerCase()}
          </option>
        ))}
      </select>
      <p className="muted">{SCORING_RULE_DESCRIPTIONS[value]}</p>
    </div>
  );
}

export function ObjectiveQuestionEditor({
  draftAssessments,
}: {
  draftAssessments: { id: string; title: string }[];
}) {
  const [state, action, pending] = useActionState<
    AssessmentActionState,
    FormData
  >(addObjectiveQuestion, {});
  const [type, setType] = useState<ObjectiveQuestionType>("SINGLE_SELECT");
  const [options, setOptions] = useState<Row[]>(() => [row(), row(), row()]);
  const [correctSingle, setCorrectSingle] = useState("");
  const [correctMulti, setCorrectMulti] = useState<string[]>([]);
  const [exactCount, setExactCount] = useState(true);
  const [items, setItems] = useState<Row[]>(() => [row(), row()]);
  const [targets, setTargets] = useState<Row[]>(() => [row(), row()]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [reuse, setReuse] = useState(false);
  // Steps are entered in their CORRECT order; the displayed order is a
  // separate arrangement the author controls and must differ from it.
  const [steps, setSteps] = useState<Row[]>(() => [row(), row(), row()]);
  const [displayOrder, setDisplayOrder] = useState<string[] | null>(null);
  const [scenario, setScenario] = useState("");
  const [fields, setFields] = useState<Field[]>(() => [
    { id: newId(), label: "", options: [row(), row()], correct: "" },
  ]);
  const [rule, setRule] = useState<Record<string, ScoringRule>>({});
  const scoringRule = (t: ObjectiveQuestionType): ScoringRule =>
    rule[t] ?? "ALL_OR_NOTHING";

  const shownSteps = useMemo(() => {
    const ids = steps.map((s) => s.id);
    const valid =
      displayOrder &&
      displayOrder.length === ids.length &&
      displayOrder.every((id) => ids.includes(id));
    return (valid ? displayOrder : [...ids].reverse()).map((id) =>
      steps.find((s) => s.id === id)!,
    );
  }, [steps, displayOrder]);

  const { interaction, answerKey } = useMemo(() => {
    const rule0 = rule[type] ?? "ALL_OR_NOTHING";
    const clean = (rows: Row[]) =>
      rows.map((r) => ({ id: r.id, label: r.label.trim() }));
    switch (type) {
      case "SINGLE_SELECT":
        return {
          interaction: { options: clean(options) },
          answerKey: { correctOptionId: correctSingle },
        };
      case "MULTIPLE_SELECT":
        return {
          interaction: {
            options: clean(options),
            requiredSelections: exactCount ? correctMulti.length : null,
            scoringRule: rule0,
          },
          answerKey: { correctOptionIds: correctMulti },
        };
      case "PBQ_MATCHING":
        return {
          interaction: {
            items: clean(items),
            targets: clean(targets),
            allowTargetReuse: reuse,
            scoringRule: rule0,
          },
          answerKey: {
            mapping: Object.fromEntries(
              items.map((i) => [i.id, mapping[i.id] ?? ""]),
            ),
          },
        };
      case "PBQ_ORDERING":
        return {
          interaction: {
            steps: clean(shownSteps),
            scoringRule: rule0,
          },
          answerKey: { correctOrder: steps.map((s) => s.id) },
        };
      case "PBQ_CONFIGURATION":
        return {
          interaction: {
            scenario: scenario.trim(),
            fields: fields.map((f) => ({
              id: f.id,
              label: f.label.trim(),
              options: clean(f.options),
            })),
            scoringRule: rule0,
          },
          answerKey: {
            values: Object.fromEntries(fields.map((f) => [f.id, f.correct])),
          },
        };
    }
  }, [
    type,
    options,
    correctSingle,
    correctMulti,
    exactCount,
    items,
    targets,
    mapping,
    reuse,
    steps,
    shownSteps,
    scenario,
    fields,
    rule,
  ]);
  const issues = [
    ...interactionIssues(type, interaction),
    ...(interactionIssues(type, interaction).length
      ? []
      : answerKeyIssues(type, interaction, answerKey)),
  ];

  return (
    <form action={action} className="support-form objective-editor">
      <Message state={state} />
      <select name="assessmentId" required defaultValue="">
        <option value="" disabled>
          Choose draft assessment
        </option>
        {draftAssessments.map((a) => (
          <option key={a.id} value={a.id}>
            {a.title}
          </option>
        ))}
      </select>
      <div className="field">
        <label htmlFor="objective-type">Question type</label>
        <select
          id="objective-type"
          name="questionType"
          value={type}
          onChange={(e) => setType(e.target.value as ObjectiveQuestionType)}
        >
          {OBJECTIVE_QUESTION_TYPES.map((t) => (
            <option key={t} value={t}>
              {QUESTION_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </div>
      <input
        type="number"
        name="position"
        min={1}
        placeholder="Question position"
        aria-label="Question position"
        required
      />
      <input
        type="number"
        name="maxMarks"
        min={1}
        max={100}
        placeholder="Maximum marks"
        aria-label="Maximum marks"
        required
      />
      <textarea
        name="prompt"
        rows={4}
        maxLength={12000}
        placeholder="Protected question prompt"
        aria-label="Protected question prompt"
        required
      />

      {(type === "SINGLE_SELECT" || type === "MULTIPLE_SELECT") && (
        <RowList
          legend="Option"
          rows={options}
          min={type === "SINGLE_SELECT" ? 2 : 3}
          max={type === "SINGLE_SELECT" ? 10 : 12}
          onChange={setOptions}
          renderExtra={(r, i) =>
            type === "SINGLE_SELECT" ? (
              <label className="objective-editor-correct">
                <input
                  type="radio"
                  name="correct-single"
                  checked={correctSingle === r.id}
                  onChange={() => setCorrectSingle(r.id)}
                />
                Correct
                <span className="sr-only"> answer is option {i + 1}</span>
              </label>
            ) : (
              <label className="objective-editor-correct">
                <input
                  type="checkbox"
                  checked={correctMulti.includes(r.id)}
                  onChange={() =>
                    setCorrectMulti((all) =>
                      all.includes(r.id)
                        ? all.filter((x) => x !== r.id)
                        : [...all, r.id],
                    )
                  }
                />
                Correct
                <span className="sr-only"> option {i + 1}</span>
              </label>
            )
          }
        />
      )}
      {type === "MULTIPLE_SELECT" && (
        <>
          <label className="objective-editor-correct">
            <input
              type="checkbox"
              checked={exactCount}
              onChange={(e) => setExactCount(e.target.checked)}
            />
            Tell learners exactly how many answers to select
          </label>
          <ScoringRuleField
            type={type}
            value={scoringRule(type)}
            onChange={(r) => setRule((all) => ({ ...all, [type]: r }))}
          />
        </>
      )}

      {type === "PBQ_MATCHING" && (
        <>
          <RowList
            legend="Target"
            rows={targets}
            min={2}
            max={12}
            onChange={setTargets}
          />
          <RowList
            legend="Item"
            rows={items}
            min={2}
            max={12}
            onChange={setItems}
            renderExtra={(r, i) => (
              <select
                aria-label={`Correct target for item ${i + 1}`}
                value={mapping[r.id] ?? ""}
                onChange={(e) =>
                  setMapping((all) => ({ ...all, [r.id]: e.target.value }))
                }
              >
                <option value="">Correct target…</option>
                {targets.map((t, ti) => (
                  <option key={t.id} value={t.id}>
                    {t.label || `Target ${ti + 1}`}
                  </option>
                ))}
              </select>
            )}
          />
          <label className="objective-editor-correct">
            <input
              type="checkbox"
              checked={reuse}
              onChange={(e) => setReuse(e.target.checked)}
            />
            Allow a target to be used by more than one item
          </label>
          <ScoringRuleField
            type={type}
            value={scoringRule(type)}
            onChange={(r) => setRule((all) => ({ ...all, [type]: r }))}
          />
        </>
      )}

      {type === "PBQ_ORDERING" && (
        <>
          <RowList
            legend="Step (enter in the correct order)"
            rows={steps}
            min={3}
            max={10}
            onChange={(next) => {
              setSteps(next);
              setDisplayOrder(null);
            }}
          />
          <fieldset className="objective-editor-list">
            <legend>Order shown to learners (must differ from correct)</legend>
            <ol>
              {shownSteps.map((s, i) => (
                <li key={s.id} className="objective-editor-row">
                  <span>{s.label || "(unlabelled step)"}</span>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={i === 0}
                    aria-label={`Show "${s.label}" earlier`}
                    onClick={() => {
                      const next = shownSteps.map((x) => x.id);
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      setDisplayOrder(next);
                    }}
                  >
                    Earlier
                  </button>
                </li>
              ))}
            </ol>
          </fieldset>
          <ScoringRuleField
            type={type}
            value={scoringRule(type)}
            onChange={(r) => setRule((all) => ({ ...all, [type]: r }))}
          />
        </>
      )}

      {type === "PBQ_CONFIGURATION" && (
        <>
          <textarea
            rows={4}
            maxLength={4000}
            value={scenario}
            onChange={(e) => setScenario(e.target.value)}
            placeholder="Scenario shown to learners (synthetic, bounded; no commands are ever executed)"
            aria-label="Configuration scenario"
          />
          {fields.map((field, fi) => (
            <fieldset key={field.id} className="objective-editor-list">
              <legend>Setting {fi + 1}</legend>
              <input
                value={field.label}
                maxLength={500}
                placeholder="Setting name, e.g. Inbound rule action"
                aria-label={`Setting ${fi + 1} name`}
                onChange={(e) =>
                  setFields((all) =>
                    all.map((f) =>
                      f.id === field.id ? { ...f, label: e.target.value } : f,
                    ),
                  )
                }
              />
              <RowList
                legend="Choice"
                rows={field.options}
                min={2}
                max={10}
                onChange={(next) =>
                  setFields((all) =>
                    all.map((f) =>
                      f.id === field.id ? { ...f, options: next } : f,
                    ),
                  )
                }
                renderExtra={(r, i) => (
                  <label className="objective-editor-correct">
                    <input
                      type="radio"
                      name={`correct-${field.id}`}
                      checked={field.correct === r.id}
                      onChange={() =>
                        setFields((all) =>
                          all.map((f) =>
                            f.id === field.id ? { ...f, correct: r.id } : f,
                          ),
                        )
                      }
                    />
                    Correct
                    <span className="sr-only"> choice {i + 1}</span>
                  </label>
                )}
              />
              <button
                type="button"
                className="button secondary"
                disabled={fields.length <= 1}
                onClick={() =>
                  setFields((all) => all.filter((f) => f.id !== field.id))
                }
              >
                Remove setting {fi + 1}
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            className="button secondary"
            disabled={fields.length >= 12}
            onClick={() =>
              setFields((all) => [
                ...all,
                {
                  id: newId(),
                  label: "",
                  options: [row(), row()],
                  correct: "",
                },
              ])
            }
          >
            Add setting
          </button>
          <ScoringRuleField
            type={type}
            value={scoringRule(type)}
            onChange={(r) => setRule((all) => ({ ...all, [type]: r }))}
          />
        </>
      )}

      <textarea
        name="expectedAnswer"
        rows={3}
        maxLength={12000}
        placeholder="Protected rationale (staff reviewers only; never shown to learners)"
        aria-label="Protected rationale"
        required
      />
      <textarea
        name="markingGuidance"
        rows={2}
        maxLength={12000}
        placeholder="Optional protected marking guidance"
        aria-label="Optional protected marking guidance"
      />
      <input
        name="reason"
        minLength={5}
        maxLength={300}
        placeholder="Institutional reason"
        aria-label="Institutional reason"
        required
      />
      <input
        type="hidden"
        name="interaction"
        value={JSON.stringify(interaction)}
      />
      <input type="hidden" name="answerKey" value={JSON.stringify(answerKey)} />
      {issues.length > 0 && (
        <p className="muted" role="status">
          Complete the question before adding it: {issues[0].message}
        </p>
      )}
      <button className="button" disabled={pending || issues.length > 0}>
        {pending ? "Adding…" : "Add objective question"}
      </button>
    </form>
  );
}
