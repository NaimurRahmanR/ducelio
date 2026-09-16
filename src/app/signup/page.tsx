import { AuthPage } from "@/components/auth-page";
export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string; next?: string }>;
}) {
  const params = await searchParams;
  return (
    <AuthPage
      mode="signup"
      error={params.error}
      message={params.message}
      next={params.next}
    />
  );
}
