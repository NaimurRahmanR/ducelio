import { notFound } from "next/navigation";
import { LiveStudent } from "@/components/live-student";
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
  return <LiveStudent section={section} />;
}
