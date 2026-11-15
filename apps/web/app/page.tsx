"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { authClient, fetchMe, type Me } from "@/lib/api";

const SIGN_OUT_FAILED = "Sign-out failed. Try again.";

export default function Home() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  // A load error replaces the page; a sign-out error keeps it so the user can retry.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    fetchMe()
      .then((user) => {
        if (user) setMe(user);
        else router.replace("/login");
      })
      .catch(() => setLoadError("The server did not answer. Is it running on port 3001?"));
  }, [router]);

  async function signOut() {
    setSigningOut(true);
    setSignOutError(null);
    try {
      const { error } = await authClient.signOut();
      if (error) {
        // The session may still be valid: say so instead of pretending the user is out.
        setSignOutError(SIGN_OUT_FAILED);
        return;
      }
      router.replace("/login");
    } catch {
      setSignOutError(SIGN_OUT_FAILED);
    } finally {
      setSigningOut(false);
    }
  }

  if (loadError) return <main className="p-8 text-red-600">{loadError}</main>;
  if (!me) return <main className="p-8 text-gray-500">Loading…</main>;

  return (
    <main className="mx-auto mt-24 max-w-md px-4">
      <h1 className="mb-6 text-2xl font-semibold">Signed in as {me.name}</h1>
      <dl className="mb-6 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-gray-500">Email</dt>
        <dd>{me.email}</dd>
        <dt className="text-gray-500">Role</dt>
        <dd>{me.role}</dd>
        <dt className="text-gray-500">Team id</dt>
        <dd className="font-mono text-xs">{me.teamId}</dd>
      </dl>
      <div className="flex items-center gap-3">
        <button
          onClick={signOut}
          disabled={signingOut}
          className="rounded border border-gray-300 px-3 py-2 disabled:opacity-60"
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
        {signOutError && (
          <p role="alert" className="text-sm text-red-700">
            {signOutError}
          </p>
        )}
      </div>
    </main>
  );
}
