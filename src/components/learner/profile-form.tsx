"use client";
import Link from "next/link";
import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Plus, Trash2 } from "lucide-react";
import type {
  CourseProgression,
  LearnerCourse,
} from "@/domain/learner-contract";
import { courseStatusLabel, formatDate, workspaceHref } from "./learner-format";
import {
  ActionFeedback,
  type LearnerActionState,
  type LearnerFormAction,
} from "./workspace-controls";

export type EducationEntry = {
  institution: string;
  qualification: string;
  fieldOfStudy: string;
  startDate: string; // YYYY-MM-DD
  endDate: string | null; // null while current
  current: boolean;
};

export type ExperienceEntry = {
  organisation: string;
  title: string;
  startDate: string; // YYYY-MM-DD
  endDate: string | null;
  current: boolean;
};

export type LearnerProfile = {
  firstName: string;
  lastName: string;
  email: string;
  pendingEmail: string | null; // a verified email change awaiting confirmation
  photoUrl: string | null; // an authorised URL for the learner's own photo
  education: EducationEntry[];
  experience: ExperienceEntry[];
};

export type EnrolledCourseSummary = {
  course: LearnerCourse;
  completion: CourseProgression["completion"] | null;
};

export const PROFILE_PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const PROFILE_PHOTO_MAX_BYTES = 1024 * 1024;

type Row<T> = T & { key: string };

const EMPTY_EDUCATION: EducationEntry = {
  institution: "",
  qualification: "",
  fieldOfStudy: "",
  startDate: "",
  endDate: null,
  current: false,
};
const EMPTY_EXPERIENCE: ExperienceEntry = {
  organisation: "",
  title: "",
  startDate: "",
  endDate: null,
  current: false,
};

// Row keys are deterministic (they also form element ids), so the server
// render and hydration agree: existing rows by position, added rows by a
// per-list counter.
function useRows<T extends { current: boolean }>(prefix: string, initial: T[]) {
  const [rows, setRows] = useState<Row<T>[]>(() =>
    initial.map((r, i) => ({ ...r, key: `${prefix}${i}` })),
  );
  const added = useRef(0);
  return {
    rows,
    add: (empty: T) =>
      setRows((r) => [
        ...r,
        { ...empty, key: `${prefix}new${++added.current}` },
      ]),
    remove: (key: string) => setRows((r) => r.filter((x) => x.key !== key)),
    setCurrent: (key: string, current: boolean) =>
      setRows((r) => r.map((x) => (x.key === key ? { ...x, current } : x))),
  };
}

function PhotoSection({
  photoUrl,
  name,
  uploadPhotoAction,
  removePhotoAction,
}: {
  photoUrl: string | null;
  name: string;
  uploadPhotoAction: LearnerFormAction;
  removePhotoAction: LearnerFormAction;
}) {
  const [upload, uploadAction, uploading] = useActionState<
    LearnerActionState,
    FormData
  >(uploadPhotoAction, {});
  const [removal, removeAction, removing] = useActionState<
    LearnerActionState,
    FormData
  >(removePhotoAction, {});
  const [preview, setPreview] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );
  const choose = (file: File | undefined) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setPreview(null);
    setProblem(null);
    if (!file) return;
    if (!PROFILE_PHOTO_TYPES.includes(file.type)) {
      setProblem("Choose a PNG, JPEG or WebP image.");
      return;
    }
    if (file.size > PROFILE_PHOTO_MAX_BYTES) {
      setProblem("Choose an image of 1 MB or less.");
      return;
    }
    previewRef.current = URL.createObjectURL(file);
    setPreview(previewRef.current);
  };
  const shown = preview ?? photoUrl;
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0])
    .join("");
  return (
    <section className="ln-panel" aria-labelledby="ln-photo-heading">
      <h2 id="ln-photo-heading">Photo</h2>
      <div className="ln-photo">
        <div className="ln-photo__frame">
          {shown ? (
            // A private, authorised image or a local preview blob; neither
            // can go through the Next.js image optimiser.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={shown}
              alt={preview ? "Preview of your new photo" : "Your profile photo"}
              width={96}
              height={96}
            />
          ) : (
            <span aria-hidden="true">{initials || "?"}</span>
          )}
        </div>
        <div className="ln-photo__controls">
          <form action={uploadAction} className="ln-inline-form">
            <label htmlFor="ln-photo-file" className="ln-label">
              {photoUrl ? "Change photo" : "Upload a photo"}
            </label>
            <input
              id="ln-photo-file"
              type="file"
              name="photo"
              accept={PROFILE_PHOTO_TYPES.join(",")}
              required
              aria-describedby="ln-photo-help"
              onChange={(e) => choose(e.currentTarget.files?.[0])}
              disabled={uploading}
            />
            <p id="ln-photo-help" className="ln-help">
              PNG, JPEG or WebP, up to 1 MB.
            </p>
            {problem && (
              <p className="ln-feedback is-error" role="alert">
                {problem}
              </p>
            )}
            <button
              className="button"
              disabled={uploading || !preview || problem !== null}
            >
              {uploading
                ? "Uploading…"
                : photoUrl
                  ? "Save new photo"
                  : "Upload photo"}
            </button>
            <ActionFeedback state={upload} />
          </form>
          {photoUrl && (
            <form action={removeAction} className="ln-inline-form">
              <button className="button secondary" disabled={removing}>
                {removing ? "Removing…" : "Remove photo"}
              </button>
              <ActionFeedback state={removal} />
            </form>
          )}
        </div>
      </div>
    </section>
  );
}

function EmailSection({
  email,
  pendingEmail,
  requestEmailChangeAction,
}: {
  email: string;
  pendingEmail: string | null;
  requestEmailChangeAction: LearnerFormAction;
}) {
  const [state, action, pending] = useActionState<LearnerActionState, FormData>(
    requestEmailChangeAction,
    {},
  );
  return (
    <section className="ln-panel" aria-labelledby="ln-email-heading">
      <h2 id="ln-email-heading">Email</h2>
      <p>
        Current email: <strong>{email}</strong>
      </p>
      {pendingEmail && !state.message && (
        <p className="ln-banner" role="status">
          A change to <strong>{pendingEmail}</strong> is waiting for
          confirmation. Your email changes only after you open the confirmation
          link sent to that address.
        </p>
      )}
      <form action={action} className="ln-form">
        <label htmlFor="ln-new-email" className="ln-label">
          New email address
        </label>
        <input
          id="ln-new-email"
          type="email"
          name="email"
          autoComplete="email"
          required
          maxLength={254}
          disabled={pending}
        />
        <p className="ln-help">
          We send a confirmation link to the new address. Nothing changes until
          you confirm it.
        </p>
        <button className="button secondary" disabled={pending}>
          {pending ? "Requesting…" : "Change email"}
        </button>
        <ActionFeedback state={state} />
      </form>
    </section>
  );
}

function DateFields({
  prefix,
  start,
  end,
  current,
  onCurrent,
  currentLabel,
}: {
  prefix: string;
  start: string;
  end: string | null;
  current: boolean;
  onCurrent: (current: boolean) => void;
  currentLabel: string;
}) {
  const id = prefix.replace(/\./g, "-");
  return (
    <>
      <div className="ln-field">
        <label htmlFor={`${id}-start`} className="ln-label">
          Start date
        </label>
        <input
          id={`${id}-start`}
          type="date"
          name={`${prefix}.startDate`}
          defaultValue={start}
          required
        />
      </div>
      <div className="ln-field">
        <label htmlFor={`${id}-end`} className="ln-label">
          End date
        </label>
        <input
          id={`${id}-end`}
          type="date"
          name={`${prefix}.endDate`}
          defaultValue={end ?? ""}
          required={!current}
          disabled={current}
        />
      </div>
      <label className="ln-check">
        <input
          type="checkbox"
          name={`${prefix}.current`}
          checked={current}
          onChange={(e) => onCurrent(e.currentTarget.checked)}
        />
        {currentLabel}
      </label>
    </>
  );
}

// Bounds mirror the profile service (src/server/learner-profile.ts): names
// up to 60 characters, other entries up to 150; only optional fields may be
// left empty.
function TextField({
  id,
  name,
  label,
  defaultValue,
  autoComplete,
  required = true,
  maxLength = 150,
}: {
  id: string;
  name: string;
  label: string;
  defaultValue: string;
  autoComplete?: string;
  required?: boolean;
  maxLength?: number;
}) {
  return (
    <div className="ln-field">
      <label htmlFor={id} className="ln-label">
        {label}
      </label>
      <input
        id={id}
        name={name}
        defaultValue={defaultValue}
        autoComplete={autoComplete}
        required={required}
        maxLength={maxLength}
      />
    </div>
  );
}

function DetailsForm({
  profile,
  saveProfileAction,
}: {
  profile: LearnerProfile;
  saveProfileAction: LearnerFormAction;
}) {
  const [state, action, pending] = useActionState<LearnerActionState, FormData>(
    saveProfileAction,
    {},
  );
  const education = useRows("edu", profile.education);
  const experience = useRows("exp", profile.experience);
  // Submitted without the automatic form reset, so the learner's saved
  // entries stay on screen while the page revalidates.
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    startTransition(() => action(form));
  };
  return (
    <form onSubmit={submit} className="ln-profile-form">
      <fieldset disabled={pending} className="ln-fieldset">
        <section className="ln-panel" aria-labelledby="ln-name-heading">
          <h2 id="ln-name-heading">Name</h2>
          <div className="ln-grid-2">
            <TextField
              id="ln-first-name"
              name="firstName"
              label="First name"
              defaultValue={profile.firstName}
              autoComplete="given-name"
              maxLength={60}
            />
            <TextField
              id="ln-last-name"
              name="lastName"
              label="Last name"
              defaultValue={profile.lastName}
              autoComplete="family-name"
              maxLength={60}
            />
          </div>
        </section>

        <section className="ln-panel" aria-labelledby="ln-education-heading">
          <h2 id="ln-education-heading">Education</h2>
          <input
            type="hidden"
            name="educationCount"
            value={education.rows.length}
          />
          {education.rows.length === 0 && (
            <p className="ln-empty-line">No education added.</p>
          )}
          {education.rows.map((row, i) => {
            const p = `education.${i}`;
            return (
              <fieldset key={row.key} className="ln-entry">
                <legend>Education {i + 1}</legend>
                <div className="ln-grid-2">
                  <TextField
                    id={`ln-${row.key}-institution`}
                    name={`${p}.institution`}
                    label="Institution"
                    defaultValue={row.institution}
                  />
                  <TextField
                    id={`ln-${row.key}-qualification`}
                    name={`${p}.qualification`}
                    label="Qualification"
                    defaultValue={row.qualification}
                  />
                  <TextField
                    id={`ln-${row.key}-field`}
                    name={`${p}.fieldOfStudy`}
                    label="Field of study (optional)"
                    defaultValue={row.fieldOfStudy}
                    required={false}
                  />
                </div>
                <div className="ln-grid-3">
                  <DateFields
                    prefix={p}
                    start={row.startDate}
                    end={row.endDate}
                    current={row.current}
                    onCurrent={(c) => education.setCurrent(row.key, c)}
                    currentLabel="I study here now"
                  />
                </div>
                <button
                  type="button"
                  className="button secondary ln-remove"
                  onClick={() => education.remove(row.key)}
                >
                  <Trash2 size={16} aria-hidden="true" /> Remove education{" "}
                  {i + 1}
                </button>
              </fieldset>
            );
          })}
          <button
            type="button"
            className="button secondary"
            onClick={() => education.add(EMPTY_EDUCATION)}
          >
            <Plus size={16} aria-hidden="true" /> Add education
          </button>
        </section>

        <section className="ln-panel" aria-labelledby="ln-experience-heading">
          <h2 id="ln-experience-heading">Experience</h2>
          <input
            type="hidden"
            name="experienceCount"
            value={experience.rows.length}
          />
          {experience.rows.length === 0 && (
            <p className="ln-empty-line">No experience added.</p>
          )}
          {experience.rows.map((row, i) => {
            const p = `experience.${i}`;
            return (
              <fieldset key={row.key} className="ln-entry">
                <legend>Experience {i + 1}</legend>
                <div className="ln-grid-2">
                  <TextField
                    id={`ln-${row.key}-organisation`}
                    name={`${p}.organisation`}
                    label="Organisation"
                    defaultValue={row.organisation}
                    autoComplete="organization"
                  />
                  <TextField
                    id={`ln-${row.key}-title`}
                    name={`${p}.title`}
                    label="Job title"
                    defaultValue={row.title}
                    autoComplete="organization-title"
                  />
                </div>
                <div className="ln-grid-3">
                  <DateFields
                    prefix={p}
                    start={row.startDate}
                    end={row.endDate}
                    current={row.current}
                    onCurrent={(c) => experience.setCurrent(row.key, c)}
                    currentLabel="I work here now"
                  />
                </div>
                <button
                  type="button"
                  className="button secondary ln-remove"
                  onClick={() => experience.remove(row.key)}
                >
                  <Trash2 size={16} aria-hidden="true" /> Remove experience{" "}
                  {i + 1}
                </button>
              </fieldset>
            );
          })}
          <button
            type="button"
            className="button secondary"
            onClick={() => experience.add(EMPTY_EXPERIENCE)}
          >
            <Plus size={16} aria-hidden="true" /> Add experience
          </button>
        </section>
      </fieldset>
      <div className="ln-savebar">
        <button className="button" disabled={pending}>
          {pending ? "Saving…" : "Save profile"}
        </button>
        <ActionFeedback state={state} />
      </div>
    </form>
  );
}

function EnrolledCourses({ enrolled }: { enrolled: EnrolledCourseSummary[] }) {
  return (
    <section className="ln-panel" aria-labelledby="ln-enrolled-heading">
      <h2 id="ln-enrolled-heading">Enrolled courses</h2>
      {enrolled.length === 0 ? (
        <p className="ln-empty-line">
          No courses yet.{" "}
          <Link className="ln-textlink" href="/courses">
            Browse Courses
          </Link>
        </p>
      ) : (
        <div className="ln-table-wrap">
          <table className="ln-table">
            <caption>
              Your enrolments. These are official records and cannot be edited
              here.
            </caption>
            <thead>
              <tr>
                <th scope="col">Course</th>
                <th scope="col">Provider</th>
                <th scope="col">Status</th>
                <th scope="col">Completion</th>
                <th scope="col">Results</th>
              </tr>
            </thead>
            <tbody>
              {enrolled.map(({ course, completion }) => (
                <tr key={course.enrolmentId}>
                  <th scope="row" data-label="Course">
                    {course.title}
                  </th>
                  <td data-label="Provider">{course.provider}</td>
                  <td data-label="Status">{courseStatusLabel(course)}</td>
                  <td data-label="Completion">
                    {completion?.completed
                      ? completion.completedAt
                        ? `Completed ${formatDate(completion.completedAt, "UTC")}`
                        : "Completed"
                      : "Not yet completed"}
                  </td>
                  <td data-label="Results">
                    <Link
                      className="ln-textlink"
                      href={`${workspaceHref(course.enrolmentId)}#ln-results-heading`}
                    >
                      View results
                      <span className="ln-sr"> for {course.title}</span>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// /student/profile: one scrolling page.
export function ProfileFormView({
  profile,
  enrolled,
  saveProfileAction,
  uploadPhotoAction,
  removePhotoAction,
  requestEmailChangeAction,
}: {
  profile: LearnerProfile | null;
  enrolled: EnrolledCourseSummary[];
  saveProfileAction: LearnerFormAction;
  uploadPhotoAction: LearnerFormAction;
  removePhotoAction: LearnerFormAction;
  requestEmailChangeAction: LearnerFormAction;
}) {
  return (
    <div className="ln-page ln-profile">
      <header className="ln-page__head">
        <h1>Profile</h1>
        <p className="ln-muted">
          Your name, photo, email, education and experience.
        </p>
      </header>
      {!profile ? (
        <div className="ln-panel">
          <p role="alert">
            Your profile could not be loaded. Nothing has changed; try again
            shortly.
          </p>
        </div>
      ) : (
        <>
          <PhotoSection
            photoUrl={profile.photoUrl}
            name={`${profile.firstName} ${profile.lastName}`}
            uploadPhotoAction={uploadPhotoAction}
            removePhotoAction={removePhotoAction}
          />
          <DetailsForm
            profile={profile}
            saveProfileAction={saveProfileAction}
          />
          <EmailSection
            email={profile.email}
            pendingEmail={profile.pendingEmail}
            requestEmailChangeAction={requestEmailChangeAction}
          />
        </>
      )}
      <EnrolledCourses enrolled={enrolled} />
    </div>
  );
}
