"use server";
import {
  removePhoto,
  requestEmailChange,
  saveProfile,
  uploadPhoto,
  type ProfileActionState,
} from "@/app/student/_actions/profile-actions";

// The profile page's actions: thin wrappers over the profile service
// actions, which re-derive identity from the session.
export async function saveMyProfileAction(
  previous: ProfileActionState,
  form: FormData,
): Promise<ProfileActionState> {
  return saveProfile(previous, form);
}

export async function uploadMyProfilePhotoAction(
  previous: ProfileActionState,
  form: FormData,
): Promise<ProfileActionState> {
  return uploadPhoto(previous, form);
}

export async function removeMyProfilePhotoAction(
  previous: ProfileActionState,
  form: FormData,
): Promise<ProfileActionState> {
  return removePhoto(previous, form);
}

export async function requestMyEmailChangeAction(
  previous: ProfileActionState,
  form: FormData,
): Promise<ProfileActionState> {
  return requestEmailChange(previous, form);
}
