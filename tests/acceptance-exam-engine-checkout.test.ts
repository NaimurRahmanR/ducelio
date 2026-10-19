import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_CHECKOUT } from "../scripts/acceptance/examiner-app.mjs";

// CP2F: hosted acceptance must exercise the exact checkout under review. The
// harness starts the app server from the repository that contains the
// harness itself, with that repository's own Next.js binary.
const THIS_REPO = fileURLToPath(new URL("..", import.meta.url));
const MIGRATION_059 = "202610160059_interactive_examination_engine.sql";

describe("CP2F acceptance app server checkout", () => {
  it("runs from this repository, not another worktree", () => {
    expect(relative(THIS_REPO, APP_CHECKOUT.root)).toBe("");
  });

  it("uses this repository's own Next.js binary", () => {
    expect(
      relative(
        join(THIS_REPO, "node_modules", "next", "dist", "bin", "next"),
        APP_CHECKOUT.nextBin,
      ),
    ).toBe("");
    expect(existsSync(APP_CHECKOUT.nextBin)).toBe(true);
  });

  it("the checkout carries the pinned migration 059 the verifier requires", () => {
    const file = join(
      APP_CHECKOUT.root,
      "supabase",
      "migrations",
      MIGRATION_059,
    );
    expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(
      "2a200a89ed11625703cd326b30ffdcc8df2462e5f9089ece5c677df71db1f2f7",
    );
  });

  it("the app server process is spawned in that checkout with that binary", () => {
    const source = readFileSync(
      new URL("../scripts/acceptance/examiner-app.mjs", import.meta.url),
      "utf8",
    );
    const start = source.slice(source.indexOf("function startAppServer("));
    const body = start.slice(0, start.indexOf("\n}\n"));
    expect(body).toMatch(/NEXT_BIN,/);
    expect(body).toMatch(/cwd: REPO_ROOT,/);
  });
});
