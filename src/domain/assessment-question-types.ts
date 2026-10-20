import { z } from "zod";

// CP2: interactive examination question types. Pure domain module: no I/O.
//
// Three deliberately separate shapes per objective question type:
//   - the INTERACTION: learner-visible presentation data (option labels,
//     items, targets, steps, configuration fields and the disclosed scoring
//     rule). Released to a learner only through the governed active-attempt
//     RPC (migration 059), never through a table grant.
//   - the ANSWER KEY: protected correct answer. Stored only in
//     assessment_question_objective_keys (no role has any table privilege)
//     and only ever read inside the database scorer.
//   - the RESPONSE: the learner's structured answer, stored as canonical JSON
//     text in the existing append-only assessment_responses.body column.
//
// The database (migration 059) is the authority for validation and scoring.
// scoreObjectiveResponse below is a reference implementation of the SAME
// documented policy, used by tests to cross-check the SQL scorer; no runtime
// path awards marks from it.

export const QUESTION_TYPES = [
  "FREE_TEXT",
  "SINGLE_SELECT",
  "MULTIPLE_SELECT",
  "PBQ_MATCHING",
  "PBQ_ORDERING",
  "PBQ_CONFIGURATION",
] as const;
export const questionTypeSchema = z.enum(QUESTION_TYPES);
export type QuestionType = z.infer<typeof questionTypeSchema>;

export const OBJECTIVE_QUESTION_TYPES = [
  "SINGLE_SELECT",
  "MULTIPLE_SELECT",
  "PBQ_MATCHING",
  "PBQ_ORDERING",
  "PBQ_CONFIGURATION",
] as const;
export const objectiveQuestionTypeSchema = z.enum(OBJECTIVE_QUESTION_TYPES);
export type ObjectiveQuestionType = z.infer<typeof objectiveQuestionTypeSchema>;

export function isObjectiveQuestionType(
  type: QuestionType,
): type is ObjectiveQuestionType {
  return type !== "FREE_TEXT";
}

// Stable, author-chosen identifiers. They never carry meaning about
// correctness (the answer key is separate), so authors should avoid ids such
// as "correct"; the UI never displays them.
export const choiceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
const labelSchema = z.string().trim().min(1).max(500);
const choiceSchema = z.strictObject({ id: choiceIdSchema, label: labelSchema });
export type Choice = z.infer<typeof choiceSchema>;

export const SCORING_RULES = {
  SINGLE_SELECT: ["ALL_OR_NOTHING"],
  MULTIPLE_SELECT: ["ALL_OR_NOTHING", "NET_PROPORTIONAL"],
  PBQ_MATCHING: ["ALL_OR_NOTHING", "PER_ITEM_PROPORTIONAL"],
  PBQ_ORDERING: ["ALL_OR_NOTHING", "PER_POSITION_PROPORTIONAL"],
  PBQ_CONFIGURATION: ["ALL_OR_NOTHING", "PER_FIELD_PROPORTIONAL"],
} as const satisfies Record<ObjectiveQuestionType, readonly string[]>;
export type ScoringRule = (typeof SCORING_RULES)[ObjectiveQuestionType][number];

// Learner-facing disclosure of each institution-selected scoring rule. The
// rule is authored per question, stored with the learner-visible
// interaction, and shown before the learner answers -- there is no
// undisclosed partial credit.
export const SCORING_RULE_DESCRIPTIONS: Record<ScoringRule, string> = {
  ALL_OR_NOTHING:
    "Full marks only for a completely correct answer; otherwise no marks.",
  NET_PROPORTIONAL:
    "Each correct selection earns a share of the marks and each incorrect selection cancels one correct selection. Marks are rounded down and never below zero.",
  PER_ITEM_PROPORTIONAL:
    "Each correctly matched item earns an equal share of the marks, rounded down.",
  PER_POSITION_PROPORTIONAL:
    "Each step in its correct position earns an equal share of the marks, rounded down.",
  PER_FIELD_PROPORTIONAL:
    "Each correctly configured setting earns an equal share of the marks, rounded down.",
};

const singleSelectInteraction = z.strictObject({
  options: z.array(choiceSchema).min(2).max(10),
});
const multipleSelectInteraction = z.strictObject({
  options: z.array(choiceSchema).min(3).max(12),
  // null => "select all that apply"; a number => "select exactly N".
  requiredSelections: z.number().int().min(1).max(11).nullable(),
  scoringRule: z.enum(SCORING_RULES.MULTIPLE_SELECT),
});
const matchingInteraction = z.strictObject({
  items: z.array(choiceSchema).min(2).max(12),
  targets: z.array(choiceSchema).min(2).max(12),
  allowTargetReuse: z.boolean(),
  scoringRule: z.enum(SCORING_RULES.PBQ_MATCHING),
});
const orderingInteraction = z.strictObject({
  // Display order. Must differ from the protected correct order.
  steps: z.array(choiceSchema).min(3).max(10),
  scoringRule: z.enum(SCORING_RULES.PBQ_ORDERING),
});
const configurationField = z.strictObject({
  id: choiceIdSchema,
  label: labelSchema,
  options: z.array(choiceSchema).min(2).max(10),
});
const configurationInteraction = z.strictObject({
  scenario: z.string().trim().min(1).max(4000),
  fields: z.array(configurationField).min(1).max(12),
  scoringRule: z.enum(SCORING_RULES.PBQ_CONFIGURATION),
});

export const interactionSchemas = {
  SINGLE_SELECT: singleSelectInteraction,
  MULTIPLE_SELECT: multipleSelectInteraction,
  PBQ_MATCHING: matchingInteraction,
  PBQ_ORDERING: orderingInteraction,
  PBQ_CONFIGURATION: configurationInteraction,
} as const;
export type SingleSelectInteraction = z.infer<typeof singleSelectInteraction>;
export type MultipleSelectInteraction = z.infer<
  typeof multipleSelectInteraction
>;
export type MatchingInteraction = z.infer<typeof matchingInteraction>;
export type OrderingInteraction = z.infer<typeof orderingInteraction>;
export type ConfigurationInteraction = z.infer<typeof configurationInteraction>;

const idRecord = z.record(choiceIdSchema, choiceIdSchema);

export const answerKeySchemas = {
  SINGLE_SELECT: z.strictObject({ correctOptionId: choiceIdSchema }),
  MULTIPLE_SELECT: z.strictObject({
    correctOptionIds: z.array(choiceIdSchema).min(1).max(11),
  }),
  PBQ_MATCHING: z.strictObject({ mapping: idRecord }),
  PBQ_ORDERING: z.strictObject({
    correctOrder: z.array(choiceIdSchema).min(3).max(10),
  }),
  PBQ_CONFIGURATION: z.strictObject({ values: idRecord }),
} as const;

export const responseSchemas = {
  SINGLE_SELECT: z.strictObject({ optionId: choiceIdSchema }),
  MULTIPLE_SELECT: z.strictObject({
    optionIds: z.array(choiceIdSchema).min(1).max(12),
  }),
  PBQ_MATCHING: z.strictObject({ matches: idRecord }),
  PBQ_ORDERING: z.strictObject({
    order: z.array(choiceIdSchema).min(3).max(10),
  }),
  PBQ_CONFIGURATION: z.strictObject({ values: idRecord }),
} as const;

export type InteractionFor<T extends ObjectiveQuestionType> = z.infer<
  (typeof interactionSchemas)[T]
>;
export type AnswerKeyFor<T extends ObjectiveQuestionType> = z.infer<
  (typeof answerKeySchemas)[T]
>;
export type ResponseFor<T extends ObjectiveQuestionType> = z.infer<
  (typeof responseSchemas)[T]
>;

export type DefinitionIssue = { path: (string | number)[]; message: string };

const ids = (choices: readonly Choice[]) => choices.map((c) => c.id);
const hasDuplicates = (values: readonly string[]) =>
  new Set(values).size !== values.length;
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v) => b.includes(v));

// Structural rules zod cannot express alone (identifier uniqueness and
// cross-references). Applied identically by the database (migration 059).
export function interactionIssues(
  type: ObjectiveQuestionType,
  interaction: unknown,
): DefinitionIssue[] {
  const parsed = interactionSchemas[type].safeParse(interaction);
  if (!parsed.success)
    return parsed.error.issues.map((i) => ({
      path: i.path as (string | number)[],
      message: i.message,
    }));
  const issues: DefinitionIssue[] = [];
  const value = parsed.data;
  const unique = (path: string, list: readonly Choice[]) => {
    if (hasDuplicates(ids(list)))
      issues.push({ path: [path], message: "Duplicate identifier." });
  };
  switch (type) {
    case "SINGLE_SELECT":
      unique("options", (value as SingleSelectInteraction).options);
      break;
    case "MULTIPLE_SELECT": {
      const v = value as MultipleSelectInteraction;
      unique("options", v.options);
      if (
        v.requiredSelections !== null &&
        v.requiredSelections >= v.options.length
      )
        issues.push({
          path: ["requiredSelections"],
          message: "Required selections must be fewer than the options.",
        });
      break;
    }
    case "PBQ_MATCHING": {
      const v = value as MatchingInteraction;
      unique("items", v.items);
      unique("targets", v.targets);
      if (!v.allowTargetReuse && v.targets.length < v.items.length)
        issues.push({
          path: ["targets"],
          message:
            "Without target reuse there must be at least as many targets as items.",
        });
      break;
    }
    case "PBQ_ORDERING":
      unique("steps", (value as OrderingInteraction).steps);
      break;
    case "PBQ_CONFIGURATION": {
      const v = value as ConfigurationInteraction;
      if (hasDuplicates(v.fields.map((f) => f.id)))
        issues.push({ path: ["fields"], message: "Duplicate identifier." });
      v.fields.forEach((field, i) => {
        if (hasDuplicates(ids(field.options)))
          issues.push({
            path: ["fields", i, "options"],
            message: "Duplicate identifier.",
          });
      });
      break;
    }
  }
  return issues;
}

export function answerKeyIssues(
  type: ObjectiveQuestionType,
  interaction: unknown,
  answerKey: unknown,
): DefinitionIssue[] {
  if (interactionIssues(type, interaction).length)
    return [{ path: [], message: "The interaction is invalid." }];
  const parsed = answerKeySchemas[type].safeParse(answerKey);
  if (!parsed.success)
    return parsed.error.issues.map((i) => ({
      path: i.path as (string | number)[],
      message: i.message,
    }));
  const issues: DefinitionIssue[] = [];
  const key = parsed.data as Record<string, unknown>;
  switch (type) {
    case "SINGLE_SELECT": {
      const v = interaction as SingleSelectInteraction;
      if (!ids(v.options).includes(key.correctOptionId as string))
        issues.push({
          path: ["correctOptionId"],
          message: "The correct option is not one of the options.",
        });
      break;
    }
    case "MULTIPLE_SELECT": {
      const v = interaction as MultipleSelectInteraction;
      const correct = key.correctOptionIds as string[];
      if (hasDuplicates(correct))
        issues.push({
          path: ["correctOptionIds"],
          message: "Duplicate correct option.",
        });
      if (!correct.every((id) => ids(v.options).includes(id)))
        issues.push({
          path: ["correctOptionIds"],
          message: "A correct option is not one of the options.",
        });
      if (correct.length >= v.options.length)
        issues.push({
          path: ["correctOptionIds"],
          message: "At least one option must be incorrect.",
        });
      if (
        v.requiredSelections !== null &&
        v.requiredSelections !== correct.length
      )
        issues.push({
          path: ["correctOptionIds"],
          message:
            "The number of correct options must equal the required selections.",
        });
      break;
    }
    case "PBQ_MATCHING": {
      const v = interaction as MatchingInteraction;
      const mapping = key.mapping as Record<string, string>;
      if (!sameSet(Object.keys(mapping), ids(v.items)))
        issues.push({
          path: ["mapping"],
          message: "The key must map every item exactly once.",
        });
      if (!Object.values(mapping).every((t) => ids(v.targets).includes(t)))
        issues.push({
          path: ["mapping"],
          message: "The key maps an item to an unknown target.",
        });
      if (!v.allowTargetReuse && hasDuplicates(Object.values(mapping)))
        issues.push({
          path: ["mapping"],
          message: "The key reuses a target although reuse is not allowed.",
        });
      break;
    }
    case "PBQ_ORDERING": {
      const v = interaction as OrderingInteraction;
      const order = key.correctOrder as string[];
      if (hasDuplicates(order) || !sameSet(order, ids(v.steps)))
        issues.push({
          path: ["correctOrder"],
          message: "The correct order must use every step exactly once.",
        });
      else if (order.every((id, i) => id === v.steps[i].id))
        issues.push({
          path: ["correctOrder"],
          message:
            "The displayed step order must differ from the correct order.",
        });
      break;
    }
    case "PBQ_CONFIGURATION": {
      const v = interaction as ConfigurationInteraction;
      const values = key.values as Record<string, string>;
      if (
        !sameSet(
          Object.keys(values),
          v.fields.map((f) => f.id),
        )
      )
        issues.push({
          path: ["values"],
          message: "The key must configure every field exactly once.",
        });
      v.fields.forEach((field) => {
        if (
          field.id in values &&
          !ids(field.options).includes(values[field.id])
        )
          issues.push({
            path: ["values", field.id],
            message: "The key selects an option the field does not offer.",
          });
      });
      break;
    }
  }
  return issues;
}

// Learner response validity against the PUBLISHED interaction. Partial
// answers are valid for matching and configuration (a learner saves
// progress); single/multiple select need a selection; ordering is always a
// complete arrangement because the UI starts from the displayed order.
export function responseIssues(
  type: ObjectiveQuestionType,
  interaction: unknown,
  response: unknown,
): DefinitionIssue[] {
  const parsed = responseSchemas[type].safeParse(response);
  if (!parsed.success)
    return [{ path: [], message: "The response does not match the question." }];
  const r = parsed.data as Record<string, unknown>;
  const bad = (message: string) => [{ path: [], message }];
  switch (type) {
    case "SINGLE_SELECT": {
      const v = interaction as SingleSelectInteraction;
      return ids(v.options).includes(r.optionId as string)
        ? []
        : bad("Unknown option.");
    }
    case "MULTIPLE_SELECT": {
      const v = interaction as MultipleSelectInteraction;
      const selected = r.optionIds as string[];
      if (hasDuplicates(selected)) return bad("Duplicate selection.");
      if (!selected.every((id) => ids(v.options).includes(id)))
        return bad("Unknown option.");
      if (
        v.requiredSelections !== null &&
        selected.length > v.requiredSelections
      )
        return bad("Too many selections.");
      return [];
    }
    case "PBQ_MATCHING": {
      const v = interaction as MatchingInteraction;
      const matches = r.matches as Record<string, string>;
      const keys = Object.keys(matches);
      if (keys.length === 0) return bad("No matches.");
      if (!keys.every((id) => ids(v.items).includes(id)))
        return bad("Unknown item.");
      if (!Object.values(matches).every((t) => ids(v.targets).includes(t)))
        return bad("Unknown target.");
      if (!v.allowTargetReuse && hasDuplicates(Object.values(matches)))
        return bad("A target may be used only once.");
      return [];
    }
    case "PBQ_ORDERING": {
      const v = interaction as OrderingInteraction;
      const order = r.order as string[];
      return !hasDuplicates(order) && sameSet(order, ids(v.steps))
        ? []
        : bad("The order must use every step exactly once.");
    }
    case "PBQ_CONFIGURATION": {
      const v = interaction as ConfigurationInteraction;
      const values = r.values as Record<string, string>;
      const keys = Object.keys(values);
      if (keys.length === 0) return bad("No settings.");
      for (const fieldId of keys) {
        const field = v.fields.find((f) => f.id === fieldId);
        if (!field) return bad("Unknown setting.");
        if (!ids(field.options).includes(values[fieldId]))
          return bad("Unknown option for a setting.");
      }
      return [];
    }
  }
}

function sortKeys(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, value[k]]),
  );
}

// One canonical text per logical answer, so the database's idempotent
// "same key + same body" replay rule recognises a retried save. Sets are
// sorted; ordering keeps its meaningful order; object keys are sorted.
export function canonicalResponseBody(
  type: ObjectiveQuestionType,
  response: unknown,
): string {
  const parsed = responseSchemas[type].parse(response) as Record<
    string,
    unknown
  >;
  switch (type) {
    case "SINGLE_SELECT":
      return JSON.stringify({ optionId: parsed.optionId });
    case "MULTIPLE_SELECT":
      return JSON.stringify({
        optionIds: [...(parsed.optionIds as string[])].sort(),
      });
    case "PBQ_MATCHING":
      return JSON.stringify({
        matches: sortKeys(parsed.matches as Record<string, string>),
      });
    case "PBQ_ORDERING":
      return JSON.stringify({ order: parsed.order });
    case "PBQ_CONFIGURATION":
      return JSON.stringify({
        values: sortKeys(parsed.values as Record<string, string>),
      });
  }
}

export function parseResponseBody(
  type: ObjectiveQuestionType,
  body: string | null | undefined,
): unknown {
  if (!body) return null;
  try {
    const value = JSON.parse(body) as unknown;
    return responseSchemas[type].safeParse(value).success ? value : null;
  } catch {
    return null;
  }
}

const share = (maxMarks: number, earned: number, total: number) =>
  total <= 0 ? 0 : Math.floor((maxMarks * Math.max(0, earned)) / total);

// Reference implementation of the documented scoring policy (see
// SCORING_RULE_DESCRIPTIONS and docs/53). An invalid or missing response
// scores 0. Integer-only arithmetic; never exceeds maxMarks.
export function scoreObjectiveResponse(
  type: ObjectiveQuestionType,
  interaction: unknown,
  answerKey: unknown,
  maxMarks: number,
  response: unknown,
): number {
  if (response === null || response === undefined) return 0;
  if (responseIssues(type, interaction, response).length) return 0;
  switch (type) {
    case "SINGLE_SELECT":
      return (response as ResponseFor<"SINGLE_SELECT">).optionId ===
        (answerKey as AnswerKeyFor<"SINGLE_SELECT">).correctOptionId
        ? maxMarks
        : 0;
    case "MULTIPLE_SELECT": {
      const v = interaction as MultipleSelectInteraction;
      const correct = (answerKey as AnswerKeyFor<"MULTIPLE_SELECT">)
        .correctOptionIds;
      const selected = (response as ResponseFor<"MULTIPLE_SELECT">).optionIds;
      const right = selected.filter((id) => correct.includes(id)).length;
      const wrong = selected.length - right;
      if (v.scoringRule === "ALL_OR_NOTHING")
        return right === correct.length && wrong === 0 ? maxMarks : 0;
      return share(maxMarks, right - wrong, correct.length);
    }
    case "PBQ_MATCHING": {
      const v = interaction as MatchingInteraction;
      const mapping = (answerKey as AnswerKeyFor<"PBQ_MATCHING">).mapping;
      const matches = (response as ResponseFor<"PBQ_MATCHING">).matches;
      const right = v.items.filter(
        (item) =>
          matches[item.id] !== undefined &&
          matches[item.id] === mapping[item.id],
      ).length;
      if (v.scoringRule === "ALL_OR_NOTHING")
        return right === v.items.length ? maxMarks : 0;
      return share(maxMarks, right, v.items.length);
    }
    case "PBQ_ORDERING": {
      const v = interaction as OrderingInteraction;
      const correct = (answerKey as AnswerKeyFor<"PBQ_ORDERING">).correctOrder;
      const order = (response as ResponseFor<"PBQ_ORDERING">).order;
      const right = order.filter((id, i) => correct[i] === id).length;
      if (v.scoringRule === "ALL_OR_NOTHING")
        return right === correct.length ? maxMarks : 0;
      return share(maxMarks, right, correct.length);
    }
    case "PBQ_CONFIGURATION": {
      const v = interaction as ConfigurationInteraction;
      const expected = (answerKey as AnswerKeyFor<"PBQ_CONFIGURATION">).values;
      const values = (response as ResponseFor<"PBQ_CONFIGURATION">).values;
      const right = v.fields.filter(
        (f) => values[f.id] !== undefined && values[f.id] === expected[f.id],
      ).length;
      if (v.scoringRule === "ALL_OR_NOTHING")
        return right === v.fields.length ? maxMarks : 0;
      return share(maxMarks, right, v.fields.length);
    }
  }
}

// Learner-facing instruction text for each type. Derived only from the
// learner-visible interaction (never the key).
export function selectionInstruction(
  type: ObjectiveQuestionType,
  interaction: unknown,
): string {
  switch (type) {
    case "SINGLE_SELECT":
      return "Choose one answer.";
    case "MULTIPLE_SELECT": {
      const n = (interaction as MultipleSelectInteraction).requiredSelections;
      return n === null
        ? "Select all answers that apply."
        : `Select exactly ${n} answer${n === 1 ? "" : "s"}.`;
    }
    case "PBQ_MATCHING":
      return (interaction as MatchingInteraction).allowTargetReuse
        ? "Match each item to a target. A target may be used more than once."
        : "Match each item to a target. Each target may be used only once.";
    case "PBQ_ORDERING":
      return "Arrange the steps into the correct order using the move controls.";
    case "PBQ_CONFIGURATION":
      return "Choose a setting for each field to configure the scenario.";
  }
}

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  FREE_TEXT: "Written answer",
  SINGLE_SELECT: "Multiple choice (one answer)",
  MULTIPLE_SELECT: "Multiple response",
  PBQ_MATCHING: "Performance-based: matching",
  PBQ_ORDERING: "Performance-based: ordering",
  PBQ_CONFIGURATION: "Performance-based: configuration",
};

// Human-readable lines for a saved structured response, using only the
// learner-visible labels (for staff review and the learner's own summary).
export function describeObjectiveResponse(
  type: ObjectiveQuestionType,
  interaction: unknown,
  body: string | null | undefined,
): string[] {
  const response = parseResponseBody(type, body);
  if (response === null || responseIssues(type, interaction, response).length)
    return [];
  const label = (choices: readonly Choice[], id: string) =>
    choices.find((c) => c.id === id)?.label ?? id;
  switch (type) {
    case "SINGLE_SELECT":
      return [
        label(
          (interaction as SingleSelectInteraction).options,
          (response as ResponseFor<"SINGLE_SELECT">).optionId,
        ),
      ];
    case "MULTIPLE_SELECT": {
      const v = interaction as MultipleSelectInteraction;
      const selected = (response as ResponseFor<"MULTIPLE_SELECT">).optionIds;
      return v.options
        .filter((o) => selected.includes(o.id))
        .map((o) => o.label);
    }
    case "PBQ_MATCHING": {
      const v = interaction as MatchingInteraction;
      const matches = (response as ResponseFor<"PBQ_MATCHING">).matches;
      return v.items
        .filter((item) => matches[item.id])
        .map((item) => `${item.label} → ${label(v.targets, matches[item.id])}`);
    }
    case "PBQ_ORDERING": {
      const v = interaction as OrderingInteraction;
      return (response as ResponseFor<"PBQ_ORDERING">).order.map(
        (id, i) => `${i + 1}. ${label(v.steps, id)}`,
      );
    }
    case "PBQ_CONFIGURATION": {
      const v = interaction as ConfigurationInteraction;
      const values = (response as ResponseFor<"PBQ_CONFIGURATION">).values;
      return v.fields
        .filter((f) => values[f.id])
        .map((f) => `${f.label}: ${label(f.options, values[f.id])}`);
    }
  }
}

export function scoringRuleOf(
  type: ObjectiveQuestionType,
  interaction: unknown,
): ScoringRule {
  return type === "SINGLE_SELECT"
    ? "ALL_OR_NOTHING"
    : (interaction as { scoringRule: ScoringRule }).scoringRule;
}
