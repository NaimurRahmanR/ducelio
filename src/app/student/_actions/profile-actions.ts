"use server";
import { revalidatePath } from "next/cache";
import {
  formFieldName,
  getMyLearnerProfile,
  profileInputFromForm,
  requestMyEmailChange,
  saveMyLearnerProfile,
} from "@/server/learner-profile";
import {
  deleteMyPrivateFile,
  MAX_PRIVATE_FILE_BYTES,
  uploadMyPrivateFile,
} from "@/server/learner-files";

// Profile server actions: (state, FormData) => { ok?, message?, error? }
// (plus fieldErrors keyed by the form's own field names). Every action
// re-derives identity from the session; the form supplies only the
// learner's own changes.
export type ProfileActionState = {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
};

const failed = (error: string): ProfileActionState => ({ ok: false, error });

// Fields: see profileInputFromForm (firstName, lastName, educationCount,
// education.N.*, experienceCount, experience.N.*; dates YYYY-MM-DD).
export async function saveProfile(
  _previous: ProfileActionState,
  form: FormData,
): Promise<ProfileActionState> {
  try {
    const result = await saveMyLearnerProfile(profileInputFromForm(form));
    if (!result.ok) {
      const fieldErrors = Object.fromEntries(
        Object.entries(result.fieldErrors).map(([k, v]) => [
          formFieldName(k),
          v,
        ]),
      );
      return {
        ok: false,
        error: fieldErrors.form ?? "Check the highlighted fields.",
        fieldErrors,
      };
    }
    revalidatePath("/student/profile");
    return { ok: true, message: "Profile saved." };
  } catch {
    return failed("Your profile could not be saved. Try again later.");
  }
}

const PHOTO_MESSAGES: Record<string, string> = {
  EMPTY_FILE: "Choose a photo to upload.",
  FILE_TOO_LARGE: "The photo must be 1 MB or smaller.",
  UNSUPPORTED_TYPE: "Use a PNG, JPEG or WebP image.",
  TYPE_MISMATCH:
    "The file does not match its type. Use a PNG, JPEG or WebP image.",
  INVALID_FILE: "The photo could not be read.",
};

// Field: photo (File). Replaces any previous photo.
export async function uploadPhoto(
  _previous: ProfileActionState,
  form: FormData,
): Promise<ProfileActionState> {
  const photo = form.get("photo");
  if (!(photo instanceof File) || photo.size === 0)
    return failed(PHOTO_MESSAGES.EMPTY_FILE);
  if (photo.size > MAX_PRIVATE_FILE_BYTES)
    return failed(PHOTO_MESSAGES.FILE_TOO_LARGE);
  try {
    const result = await uploadMyPrivateFile({
      purpose: "PROFILE_PHOTO",
      name: photo.name,
      type: photo.type,
      bytes: new Uint8Array(await photo.arrayBuffer()),
    });
    if (!result.ok)
      return failed(
        PHOTO_MESSAGES[result.code] ?? "The photo could not be saved.",
      );
    revalidatePath("/student/profile");
    return { ok: true, message: "Photo updated." };
  } catch {
    return failed("The photo could not be saved. Try again later.");
  }
}

// No fields: removes the signed-in learner's current photo.
export async function removePhoto(
  _previous: ProfileActionState,
  _form?: FormData,
): Promise<ProfileActionState> {
  void _form;
  try {
    const { photo } = await getMyLearnerProfile();
    if (!photo) return { ok: true, message: "No photo to remove." };
    const result = await deleteMyPrivateFile(photo.fileId);
    if (!result.ok) return failed("The photo could not be removed.");
    revalidatePath("/student/profile");
    return { ok: true, message: "Photo removed." };
  } catch {
    return failed("The photo could not be removed. Try again later.");
  }
}

// Field: email. Starts Supabase Auth's verified email-change flow; the
// address changes only after the confirmation link(s) are followed.
export async function requestEmailChange(
  _previous: ProfileActionState,
  form: FormData,
): Promise<ProfileActionState> {
  try {
    const result = await requestMyEmailChange(form.get("email"));
    if (!result.ok) return failed(result.error);
    return {
      ok: true,
      message:
        "Check your inbox to confirm the new address. Your current address stays active until the change is confirmed.",
    };
  } catch {
    return failed("The email change could not be started. Try again later.");
  }
}
