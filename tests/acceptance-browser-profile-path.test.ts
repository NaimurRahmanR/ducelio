import { expect, it } from "vitest";
import { resolve, join } from "node:path";
import { verifiedBrowserProfilePath } from "../scripts/acceptance/exam-engine-browser.mjs";

it("bounds temporary browser cleanup to one named direct child", () => {
  const root = resolve("work/browser-profile-test");
  expect(
    verifiedBrowserProfilePath(join(root, "ducelio-cp2-chrome-aB1234"), root),
  ).toBe(join(root, "ducelio-cp2-chrome-aB1234"));
  for (const path of [
    root,
    join(root, "other"),
    join(root, "nested/ducelio-cp2-chrome-abc"),
    join(root, "../ducelio-cp2-chrome-abc"),
  ])
    expect(() => verifiedBrowserProfilePath(path, root)).toThrow("Refusing");
});
