import { createAuthClient } from "better-auth/react";

/** The Hono server (apps/server). The browser calls it directly, with the session cookie. */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** Better Auth's client: signIn.email, signOut, ... against API_URL/api/auth. */
export const authClient = createAuthClient({ baseURL: API_URL });

/** What GET /me returns. Role and team are decided by the server, never by this app. */
export type Me = {
  id: string;
  email: string;
  name: string;
  role: "employee" | "manager" | "hr";
  teamId: string;
};

/** The signed-in user, or null when the server answers 401. */
export async function fetchMe(): Promise<Me | null> {
  // credentials: "include" sends the session cookie to the other port (3001).
  const response = await fetch(`${API_URL}/me`, { credentials: "include" });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`GET /me failed: ${response.status}`);
  return (await response.json()) as Me;
}
