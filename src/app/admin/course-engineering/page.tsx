import Link from "next/link";
import { z } from "zod";
import { requireAnyRole } from "@/server/identity";
import {
  listCoursePackages,
  getCoursePackagePreview,
  getCoursePackageTestStatus,
} from "@/server/course-engineering";
import { listAgentConfigs } from "@/server/academic-agent-config";
import {
  agentRoleSchema,
  type AgentConfigRecord,
} from "@/domain/academic-agent-config";
import {
  operatorPreviewSchema,
  type OperatorPreview,
  type TestStatusResult,
} from "@/domain/course-engineering-admin";
import { StaffShell, adminSectionsForRoles } from "@/components/staff-shell";
import { Card } from "@/components/ui";
import {
  CoursePackageImportForm,
  CoursePackageLifecycleForm,
  CourseAgentForm,
  CourseTestForm,
} from "@/components/course-engineering-forms";

export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ importId?: string }>;
}) {
  const actor = await requireAnyRole(["ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
  const params = await searchParams;
  const id = z.uuid().safeParse(params.importId);
  const { packages, listingFailed } = await listCoursePackages().then(
    (packages) => ({ packages, listingFailed: false }),
    () => ({ packages: [], listingFailed: true }),
  );
  const selected = id.success
    ? packages.find((p) => p.id === id.data)
    : undefined;
  let preview: OperatorPreview | null = null;
  if (selected) {
    try {
      const result = await getCoursePackagePreview(selected.id);
      if (
        result.id === selected.id &&
        result.programme_version_id === selected.programme_version_id
      )
        preview = operatorPreviewSchema.parse(result.preview);
    } catch {
      /* Never render or log unvalidated payloads or RPC diagnostics. */
    }
  }
  let configs: AgentConfigRecord[] = [];
  let configFailed = false;
  if (selected?.programme_version_id) {
    try {
      configs = await listAgentConfigs(selected.programme_version_id);
    } catch {
      configFailed = true;
    }
  }
  // Server/database-derived only: the browser never calculates publication
  // authority. publish_course_package independently re-derives and
  // re-checks the current fingerprint itself regardless of what this page
  // shows; this status is display-only. Pre-publication readiness only
  // applies while the package is APPLIED, and only gates APPLIED -> Publish
  // below. The publication fingerprint binds programme_versions.status, so
  // a pre-publication PASS (recorded while status is DRAFT) necessarily
  // stops matching the current fingerprint the moment publication succeeds
  // and status becomes PUBLISHED -- recomputing readiness after publication
  // would therefore always show it as stale, even though publication
  // already succeeded. Once course_package_imports.status is PUBLISHED,
  // that status itself is the proof that publish_course_package's own
  // database test gate already passed; readiness is never re-checked.
  let testStatus: TestStatusResult | null = null;
  if (selected?.programme_version_id && selected.status === "APPLIED") {
    try {
      testStatus = await getCoursePackageTestStatus(selected.id);
    } catch {
      testStatus = null;
    }
  }
  const publicationReady = testStatus?.status === "PASSED_CURRENT";
  return (
    <StaffShell
      kind="admin"
      name={actor.displayName}
      section="Course Engineering"
      sections={adminSectionsForRoles(actor.roles)}
      roles={actor.roles}
    >
      <Card>
        <h2>Course &amp; Agent Engineering</h2>
        <p>
          Import → validate → preview → apply → configure agents → run
          pre-publication test → publish → activate → commercial offer.
        </p>
        <p>
          Course content is uploaded data. No course-specific code, migration or
          deployment is needed.
        </p>
        <CoursePackageImportForm />
      </Card>
      <Card>
        <h2>Course packages</h2>
        {listingFailed ? (
          <p role="alert">Package listing is unavailable. Please try again.</p>
        ) : !packages.length ? (
          <p>No packages have been imported.</p>
        ) : (
          <div className="engineering-table">
            <table>
              <caption>Authoritative package lifecycle</caption>
              <thead>
                <tr>
                  <th>Package / revision</th>
                  <th>Status</th>
                  <th>Version / provenance</th>
                  <th>Lifecycle timestamps</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {packages.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.package_key}
                      <br />
                      Revision {p.package_revision}
                      <br />
                      {p.schema_version}
                    </td>
                    <td>{p.status}</td>
                    <td>
                      Programme: {p.programme_id ?? "Not applied"}
                      <br />
                      Version: {p.programme_version_id ?? "Not applied"}
                      <details>
                        <summary>Content hash</summary>
                        <code>{p.content_hash}</code>
                      </details>
                    </td>
                    <td>
                      Imported: {p.created_at}
                      <br />
                      Applied: {p.applied_at ?? "—"}
                      <br />
                      Published: {p.published_at ?? "—"}
                      <br />
                      Rejected: {p.rejected_at ?? "—"}
                    </td>
                    <td>
                      <Link
                        className="text-link"
                        href={`/admin/course-engineering?importId=${encodeURIComponent(p.id)}`}
                      >
                        Review {p.package_key}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {params.importId && !selected && (
        <Card>
          <p role="alert">
            Choose an available package from the list. The requested package
            could not be loaded.
          </p>
        </Card>
      )}
      {selected && (
        <>
          <Card>
            <h2>
              Review: {selected.package_key} · revision{" "}
              {selected.package_revision}
            </h2>
            <p>
              Status: <strong>{selected.status}</strong>
            </p>
            <CoursePackageLifecycleForm
              key={selected.id + selected.status}
              importId={selected.id}
              status={selected.status}
              publicationReady={publicationReady}
            />
          </Card>
          <Card>
            <h2>Safe course preview</h2>
            {preview ? (
              <CoursePreview preview={preview} />
            ) : (
              <p role="alert">
                A structured preview is unavailable for this package. Validate
                the staged revision to check its structure; no raw content is
                displayed.
              </p>
            )}
          </Card>
          <Card>
            <h2>Explicit agent configuration</h2>
            <p>
              Package proposals are informational. Import, validation and Apply
              do not save agent configuration. Review and save each role
              deliberately, including disabled roles. Missing configuration
              remains fail-closed.
            </p>
            <p>
              Activation requires saved configurations to match the package
              proposals. If a proposal needs changing, correct the source
              package and import a new revision; activation will not silently
              overwrite a conflicting configuration.
            </p>
            {!selected.programme_version_id &&
              preview &&
              agentRoleSchema.options.map((role) => (
                <details key={role}>
                  <summary>{role} proposal (not an approval)</summary>
                  <pre className="engineering-json">
                    {JSON.stringify(preview.agentConfiguration[role], null, 2)}
                  </pre>
                </details>
              ))}
            {!selected.programme_version_id ? (
              <p>
                Apply the validated package first to create the programme
                version these configurations belong to.
              </p>
            ) : configFailed ? (
              <p role="alert">
                Saved agent configurations could not be loaded. Refresh before
                editing.
              </p>
            ) : (
              agentRoleSchema.options.map((role) => (
                <details key={role} className="engineering-role">
                  <summary>
                    {role} ·{" "}
                    {configs.some((c) => c.role === role)
                      ? "saved"
                      : "not configured"}
                  </summary>
                  {preview && (
                    <>
                      <h3>Package proposal (not an approval)</h3>
                      <pre className="engineering-json">
                        {JSON.stringify(
                          preview.agentConfiguration[role],
                          null,
                          2,
                        )}
                      </pre>
                    </>
                  )}
                  <CourseAgentForm
                    key={
                      selected.id +
                      role +
                      (configs.find((c) => c.role === role)?.updatedAt ?? "new")
                    }
                    importId={selected.id}
                    role={role}
                    config={configs.find((c) => c.role === role)}
                    frozen={selected.status === "PUBLISHED"}
                  />
                </details>
              ))
            )}
          </Card>
          {selected.programme_version_id && selected.status === "APPLIED" && (
            <Card>
              <h2>Pre-publication test</h2>
              {testStatus ? (
                <CourseTestForm
                  importId={selected.id}
                  testStatus={testStatus}
                />
              ) : (
                <p role="alert">
                  Test readiness is unavailable. Refresh before running the
                  test.
                </p>
              )}
            </Card>
          )}
          <Card>
            <h2>Continue delivery setup</h2>
            {selected.status === "PUBLISHED" ? (
              <Link
                className="button"
                href={`/admin/activation?importId=${encodeURIComponent(selected.id)}`}
              >
                Activate course delivery
              </Link>
            ) : (
              <p>
                Publish the package with all five role configurations matching
                the reviewed package proposal before continuing to activation.
              </p>
            )}
            <p>
              After activation,{" "}
              <Link className="text-link" href="/admin/commerce">
                manage commercial offers
              </Link>{" "}
              to set an explicit price. This page does not create an activation
              or assign pricing.
            </p>
          </Card>
        </>
      )}
    </StaffShell>
  );
}

function CoursePreview({ preview: p }: { preview: OperatorPreview }) {
  return (
    <>
      <h3>{p.programme.title}</h3>
      <p>
        {p.programme.examinationBody} · {p.programme.qualificationName} ·
        Curriculum {p.curriculumVersion.label}
      </p>
      {p.modules.map((m) => (
        <details key={m.key}>
          <summary>
            Module {m.position}: {m.title}
          </summary>
          {m.lessons.map((l) => (
            <section key={l.key}>
              <h4>
                Lesson {l.position}: {l.title}
              </h4>
              <ul>
                {l.objectives.map((o) => (
                  <li key={o.key}>{o.description}</li>
                ))}
              </ul>
              <h5>Learning resources</h5>
              {l.resources.map((r) => (
                <details key={r.key}>
                  <summary>
                    {r.title} ({r.kind})
                  </summary>
                  <p className="engineering-prose">{r.body ?? r.url}</p>
                </details>
              ))}
              <h5>Practical activities</h5>
              {l.practicalActivities.map((a) => (
                <details key={a.key}>
                  <summary>
                    {a.title} ({a.kind})
                  </summary>
                  <p className="engineering-prose">{a.instructions}</p>
                  <p>Objectives: {a.objectiveRefs.join(", ")}</p>
                </details>
              ))}
            </section>
          ))}
        </details>
      ))}
      <h3>Assignment templates</h3>
      {!p.assignmentTemplates.length ? (
        <p>None proposed.</p>
      ) : (
        p.assignmentTemplates.map((a) => (
          <details key={a.key}>
            <summary>
              {a.title} · lesson {a.lessonRef}
            </summary>
            <p>{a.instructions}</p>
            <ul>
              {a.rubric.map((r, i) => (
                <li key={i}>
                  {r.description} · {r.maxMarks} marks
                </li>
              ))}
            </ul>
          </details>
        ))
      )}
      <h3>Controlled-assessment metadata</h3>
      <p>
        Question prompts, expected answers and marking guidance are excluded
        from this operator preview.
      </p>
      {p.assessmentTemplates.map((a) => (
        <p key={a.key}>
          {a.title} · lesson {a.lessonRef} · {a.durationMinutes} minutes ·{" "}
          {a.attemptsAllowed} attempt(s) · {a.questionCount} questions ·{" "}
          {a.totalMarks} marks
        </p>
      ))}
      <h3>Proposed schedule defaults</h3>
      <p>
        Study weekdays (1 = Monday): {p.schedulingDefaults.studyDays.join(", ")}{" "}
        · {p.schedulingDefaults.localStartTime} ·{" "}
        {p.schedulingDefaults.timezone}. These describe the proposal; governed
        scheduling policy remains authoritative.
      </p>
    </>
  );
}
