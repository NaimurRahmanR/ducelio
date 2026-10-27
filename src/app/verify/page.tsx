import type { Metadata } from "next";
import { Badge, Brand, Card } from "@/components/ui";
import { config } from "@/lib/env";
import {
  verifyCertificate,
  type CertificateVerification,
} from "@/server/learner-certificates";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Verify a certificate | Ducelio",
  robots: { index: false, follow: false },
};

const dateLabel = (isoDate: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00Z`));

// Public certificate verification. Anyone with a code sees only the minimal
// public fields; all values are rendered as text.
export default async function VerifyCertificatePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const raw = (await searchParams).code;
  const code = (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, 40) ?? "";
  let result: CertificateVerification | null = null;
  let unavailable = false;
  if (code) {
    if (!config().configured) unavailable = true;
    else
      try {
        result = await verifyCertificate(code);
      } catch {
        unavailable = true;
      }
  }
  return (
    <main id="main" tabIndex={-1} className="foundation">
      <Brand />
      <h1>Verify a Ducelio certificate</h1>
      <p>
        Enter the verification code printed on the certificate, for example
        ABCD-EFGH-JKLM-NPQR.
      </p>
      <form method="get" action="/verify">
        <label htmlFor="code">Verification code</label>
        <input
          id="code"
          name="code"
          defaultValue={code}
          required
          minLength={16}
          maxLength={40}
          autoComplete="off"
          spellCheck={false}
        />
        <button className="button" type="submit">
          Verify
        </button>
      </form>
      {unavailable && (
        <p role="alert">
          Verification is unavailable right now. Try again later.
        </p>
      )}
      {result && !result.found && (
        <Card>
          <h2>No certificate found</h2>
          <p role="status">
            No Ducelio certificate matches this code. Check the code and try
            again.
          </p>
        </Card>
      )}
      {result && result.found && (
        <Card>
          <h2>
            {result.valid ? "Valid certificate" : "Certificate revoked"}{" "}
            <Badge tone={result.valid ? "green" : "muted"}>
              {result.valid ? "Valid" : "Revoked"}
            </Badge>
          </h2>
          <dl role="status">
            <dt>Learner (name as provided)</dt>
            <dd>{result.learnerName}</dd>
            <dt>Course</dt>
            <dd>{result.courseTitle}</dd>
            <dt>Issued by</dt>
            <dd>{result.issuerName}</dd>
            <dt>Completed on</dt>
            <dd>{dateLabel(result.completedOn)}</dd>
            {result.revokedOn && (
              <>
                <dt>Revoked on</dt>
                <dd>{dateLabel(result.revokedOn)}</dd>
              </>
            )}
            <dt>Code</dt>
            <dd>{result.verificationCode}</dd>
          </dl>
          <p>
            The learner&apos;s name is shown as they entered it in their profile
            when the certificate was issued; Ducelio does not check identity
            documents.
          </p>
          {result.preparationCourse && (
            <p>
              This certificate confirms completion of a Ducelio preparation
              course. It is not an official certification from the examination
              body.
            </p>
          )}
        </Card>
      )}
    </main>
  );
}
