import { redirect } from "next/navigation";
import { z } from "zod";

export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ packageId?: string }>;
}) {
  const id = z.uuid().safeParse((await searchParams).packageId);
  redirect(
    id.success
      ? `/admin/course-engineering?packageId=${id.data}`
      : "/admin/course-engineering",
  );
}
