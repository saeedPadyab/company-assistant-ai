"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { authClient, fetchMe, type Me } from "@/lib/api";

export default function Home() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMe()
      .then((user) => {
        if (user) setMe(user);
        else router.replace("/login");
      })
      .catch(() => setError("The server did not answer. Is it running on port 3001?"));
  }, [router]);

  async function signOut() {
    const { error } = await authClient.signOut();
    if (error) {
      // The session may still be valid: say so instead of pretending the user is out.
      setError("Sign-out failed. Try again.");
      return;
    }
    router.replace("/login");
  }

  if (error) return <main className="p-8 text-red-600">{error}</main>;
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
      <button onClick={signOut} className="rounded border border-gray-300 px-3 py-2">
        Sign out
      </button>
    </main>
  );
}
