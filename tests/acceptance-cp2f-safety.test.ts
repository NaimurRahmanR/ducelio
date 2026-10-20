import { expect, it } from "vitest";
import { isApprovedDbPush } from "../scripts/acceptance/supabase-linked-command.mjs";
import {
  SURFACES,
  examEngineExitCode,
  surface,
} from "../scripts/acceptance/exam-engine.mjs";

it("allows only the two approved migration commands", () => {
  for (const mode of ["--dry-run", "--yes"])
    expect(
      isApprovedDbPush(["db", "push", "--linked", "--skip-vault", mode]),
    ).toBe(true);

  for (const args of [
    ["db", "reset", "--linked", "--skip-vault", "--yes"],
    ["db", "pull", "--linked", "--skip-vault", "--yes"],
    ["db", "dump", "--linked", "--skip-vault", "--yes"],
    ["db", "push", "--linked", "--skip-vault", "--yes", "--yes"],
    ["db", "push", "--linked", "--skip-vault", "--dry-run", "--yes"],
    ["db", "push", "--linked", "--yes"],
    ["db", "push", "--linked", "--skip-vault", "--db-url=x"],
    ["db", "push", "--linked", "--skip-vault", "--local"],
  ])
    expect(isApprovedDbPush(args)).toBe(false);
});

it("acceptance requires exactly 11 successful surfaces", () => {
  const good = SURFACES.map((surface: string) => ({ surface, status: "PASS" }));
  expect(examEngineExitCode(good)).toBe(0);

  for (const status of ["BLOCKED", "NOT_RUN", "FAIL"])
    expect(examEngineExitCode([{ ...good[0], status }, ...good.slice(1)])).toBe(
      1,
    );

  expect(examEngineExitCode([])).toBe(1);
  expect(examEngineExitCode(good.slice(1))).toBe(1);
  expect(examEngineExitCode([...good.slice(1), good[1]])).toBe(1);
});

it("exceptions do not expose external secrets", async () => {
  const result = await surface("SYNTHETIC", async () => {
    throw Error("SYNTHETIC_SECRET_VALUE");
  });
  expect(result.status).toBe("FAIL");
  expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET_VALUE");
});
