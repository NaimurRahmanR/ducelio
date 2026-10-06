import { createHash, createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  tutorLabFixture,
  asExecutionUser,
  learner,
  type TutorLabFixture,
} from "./tutor-lab-fixture";
import {
  signedTutorLabCommand,
  sendTutorLabCommand,
} from "./tutor-lab-provider-execution-fixture";

// AC-4 behaviour-version decision, on the real migration chain: a programme
// version genuinely frozen on TUTOR_BEHAVIOUR_V1 (published under migration
// 051's own role-version definition) can keep Tutor notes exactly like a V2
// version. Note keeping does not change the Tutor's Level-2 contract, so it
// is not gated on a behaviour version; the provenance must still equal the
// version's own frozen binding.
let f: TutorLabFixture;
beforeAll(async () => {
  f = await tutorLabFixture({ publishBeforeMigration052: true });
});
afterAll(async () => {
  await f.db?.close();
});

async function value<T = unknown>(sql: string, args: unknown[] = []) {
  return (await f.db.query<{ v: T }>(sql, args)).rows[0].v;
}

describe("AC-4 on a TUTOR_BEHAVIOUR_V1-pinned programme version", () => {
  it("records and lists a Tutor note whose provenance names the frozen V1 binding", async () => {
    expect(
      await value<string>(
        "select behaviour_version as v from public.academic_agent_behaviour_bindings where programme_version_id=$1 and role='TUTOR'",
        [f.programmeVersionId],
      ),
    ).toBe("TUTOR_BEHAVIOUR_V1");
    await asExecutionUser(f.db, 1);
    const opened = await value<{ release_id: string }>(
      "select public.begin_tutor_lab_content_release($1,$2) as v",
      [randomUUID(), f.missedLessonHandoffId],
    );
    const executionId = randomUUID();
    const base = { role: "TUTOR", executionId, releaseId: opened.release_id };
    await sendTutorLabCommand(f.db, signedTutorLabCommand(f, base));
    await sendTutorLabCommand(
      f.db,
      signedTutorLabCommand(f, {
        ...base,
        operation: "START",
        state: "RUNNING",
        maxCalls: 0,
        maxOutput: 0,
        maxCost: 0,
      }),
    );
    await value("select public.close_tutor_lab_content_release($1,true) as v", [
      opened.release_id,
    ]);
    await sendTutorLabCommand(
      f.db,
      signedTutorLabCommand(f, {
        ...base,
        operation: "FINALIZE",
        state: "SUCCEEDED",
        reason: "PROVIDER_COMPLETE",
        maxCalls: 0,
        maxOutput: 0,
        maxCost: 0,
      }),
    );
    const body = "V1-pinned Tutor answer";
    const issuedAt = Math.floor(Date.now() / 1000);
    const canonical = [
      "DUCELIO_TUTOR_CLASS_NOTE_HMAC_SHA256_V1",
      "TUTOR",
      f.keyId,
      learner,
      executionId,
      createHash("sha256").update(body, "utf8").digest("hex"),
      String(issuedAt),
      String(issuedAt + 10),
    ].join("\n");
    expect(
      await value(
        "select public.record_tutor_class_note($1,$2,$3,$4,$5,$6) as v",
        [
          f.keyId,
          executionId,
          body,
          issuedAt,
          issuedAt + 10,
          createHmac("sha256", f.key).update(canonical).digest("hex"),
        ],
      ),
    ).toEqual({ ok: true, duplicate: false, revisionNumber: 1 });
    const listed = await value<{ notes: { revisions: { body: string }[] }[] }>(
      "select public.list_my_tutor_class_notes($1,0) as v",
      [f.learnerEnrolmentId],
    );
    expect(listed.notes[0].revisions[0].body).toBe(body);
    await f.db.exec("reset role");
    expect(
      await value<string>(
        "select p.behaviour_version as v from public.tutor_class_note_revisions r join public.academic_agent_execution_provenance p on p.id=r.source_provenance_id",
      ),
    ).toBe("TUTOR_BEHAVIOUR_V1");
  });
});
