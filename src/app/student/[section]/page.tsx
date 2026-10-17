import { notFound } from "next/navigation";
import { LiveStudent } from "@/components/live-student";
import { StudentAssignments } from "@/components/student-assignments";
import { StudentAssessmentPage } from "@/components/student-assessment-page";
import { StudentNotificationPage } from "@/components/student-notification-page";
import { studentAssessmentPage } from "@/server/assessments";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ section: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { section } = await params;
  if (
    ![
      "programme",
      "calendar",
      "classes",
      "assignments",
      "assessments",
      "notes",
      "results",
      "support",
      "notifications",
      "profile",
      "study-plan",
      "announcements",
    ].includes(section)
  )
    notFound();

  if (section === "assignments") return <StudentAssignments />;
  if (section === "assessments")
    return (
      <StudentAssessmentPage
        page={studentAssessmentPage((await searchParams).page)}
      />
    );
  if (section === "notifications") return <StudentNotificationPage />;
  return <LiveStudent section={section} />;
}
