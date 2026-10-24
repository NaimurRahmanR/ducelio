import { tabForSection } from "@/domain/admin-academy-tabs";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { courseEngineeringAccess } from "@/server/course-organisations";
export const dynamic = "force-dynamic";
export default async function Page(_props: {
  searchParams?: Promise<unknown>;
}): Promise<ReactNode> {
  const access = await courseEngineeringAccess();
  const params = await _props?.searchParams;
  if (
    params &&
    typeof params === "object" &&
    "section" in params &&
    typeof params.section === "string" &&
    access.actor.roles.some(
      (r) =>
        r === "REGISTRAR" || r === "ACADEMIC_ADMIN" || r === "PLATFORM_ADMIN",
    )
  ) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      if (typeof value === "string" && value.length < 200)
        query.set(key, key === "section" ? value.toLowerCase() : value);
    query.set("tab", tabForSection(params.section));
    redirect("/admin/academy?" + query.toString());
  }
  if (access.allowed) redirect("/admin/course-engineering");
  if (access.actor.roles.includes("REGISTRAR")) redirect("/admin/academy");
  redirect("/student/academy");
}
