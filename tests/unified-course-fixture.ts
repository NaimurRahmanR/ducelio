import {
  approvedTestPackage,
  people,
  rpc,
  type Query,
} from "./academy-fixture";
import { validateAcademyCoursePackage } from "@/domain/academy-course-package";

export async function publishUnifiedTestCourse(
  q: Query,
  key: string,
  price = 10001,
  currency: "GBP" | "USD" | "EUR" = "GBP",
) {
  const pkg = approvedTestPackage(key);
  pkg.course.demoContent = true;
  const checked = validateAcademyCoursePackage(pkg);
  if (!checked.valid) throw new Error(JSON.stringify(checked.errors));
  const reason = "Synthetic unified course acceptance fixture";
  const packageId = await rpc<string>(
    q,
    people.admin,
    "upload_unified_course_package",
    [JSON.stringify(pkg), reason],
  );
  await rpc(q, people.admin, "mark_academy_course_package_validated", [
    packageId,
    JSON.stringify(checked.review),
    reason,
  ]);
  return rpc<{ courseId: string; offerId: string }>(
    q,
    people.admin,
    "publish_unified_course",
    [packageId, key, currency, price, null, reason],
  );
}
