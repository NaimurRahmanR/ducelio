import { notFound } from "next/navigation";
import { LiveStudent } from "@/components/live-student";
import { StudentAssignments } from "@/components/student-assignments";

export default async function Page({
  params,
}: {
  params: Promise<{ section: string }>;
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
      "profile",
      "study-plan",
      "announcements",
    ].includes(section)
  )
    notFound();

  if (section === "assignments") return <StudentAssignments />;
  return <LiveStudent section={section} />;
}
