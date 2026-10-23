import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { signInThroughUi } from "../scripts/acceptance/exam-engine-browser.mjs";

it("submits the email login form, not a social login form", async () => {
  const clicks: string[] = [];
  const page = {
    goto: async () => true,
    typeInto: async () => {},
    click: async (selector: string) => {
      clicks.push(selector);
    },
    waitFor: async () => true,
    evaluate: async () => true,
  };

  await signInThroughUi(
    page as unknown as Parameters<typeof signInThroughUi>[0],
    "http://127.0.0.1:3000",
    "synthetic@example.test",
    "synthetic-password",
  );

  expect(clicks).toEqual([
    "document.querySelector('input[name=email]')?.form?.querySelector('button[type=submit]')",
  ]);
});

it("does not type credentials or submit before the actual form hydrates", async () => {
  let typed = false,
    submitted = false;
  const page = {
    goto: async () => true,
    waitFor: async () => false,
    typeInto: async () => {
      typed = true;
    },
    click: async () => {
      submitted = true;
    },
  };
  await expect(
    signInThroughUi(
      page,
      "http://127.0.0.1:3000",
      "synthetic@example.test",
      "synthetic-password",
    ),
  ).rejects.toThrow("Sign-in form did not hydrate");
  expect(typed).toBe(false);
  expect(submitted).toBe(false);
});

it("provides a future browser opening and review start margin", () => {
  const source = readFileSync("scripts/acceptance/exam-engine.mjs", "utf8");

  expect(source).toContain("const firstOpensAt = Date.now() + 120_000;");
  expect(source).toContain(
    'await waitUntil(windows.QUIZ_1, "QUIZ_1 window", log);',
  );
  expect(source).toContain(
    "assessmentSchedule: { firstOpensAt, windowMinutes: 90 }",
  );
  expect(source).toContain('["review", 90]');
});
