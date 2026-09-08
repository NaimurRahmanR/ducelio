"use server";

import { revalidatePath } from "next/cache";
import { publishProgrammeVersion } from "@/server/programmes";

export type ProgrammeActionState = { error?: string; message?: string };

export async function publishProgramme(
  _state: ProgrammeActionState,
  form: FormData,
): Promise<ProgrammeActionState> {
  try {
    await publishProgrammeVersion({
      programmeVersionId: form.get("programmeVersionId"),
      reason: form.get("reason"),
    });
  } catch {
    return {
      error:
        "Unable to publish this version. Check its curriculum completeness and your permissions.",
    };
  }

  revalidatePath("/admin");
  return { message: "Programme version published." };
}
