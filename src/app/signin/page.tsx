import { SignInForm } from "@/components/auth/SignInForm";
import { safeNext, testMode } from "@/lib/auth";

export const dynamic = "force-dynamic"; // reads AUTH_ENFORCED at request time

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string; mode?: string }> }) {
  const { next, mode } = await searchParams;
  return <SignInForm testMode={testMode()} next={safeNext(next)} initialMode={mode === "register" ? "register" : "login"} />;
}
