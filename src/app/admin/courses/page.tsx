import { requireActor } from "@/server/identity";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
export default async function Page(_props: {
  searchParams?: Promise<unknown>;
  params?: Promise<unknown>;
}): Promise<ReactNode> {
  void _props;
  await requireActor();
  redirect("/admin/course-engineering");
}
