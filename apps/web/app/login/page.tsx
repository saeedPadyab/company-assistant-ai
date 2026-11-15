"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { authClient } from "@/lib/api";
import { PasswordField } from "./password-field";

const WRONG_CREDENTIALS = "Email or password is wrong.";
const NO_ANSWER = "The server did not answer. Try again.";
const FAILED = "Sign-in failed. Try again.";

type Failure = { message: string; wrongCredentials: boolean };

export default function LoginPage() {
  const router = useRouter();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFailure(null);
    try {
      const { error } = await authClient.signIn.email({
        email: String(form.get("email")),
        password: String(form.get("password")),
      });
      if (!error) {
        router.push("/");
        return;
      }
      if (error.status === 401) setFailure({ message: WRONG_CREDENTIALS, wrongCredentials: true });
      // better-fetch reports a request that got no HTTP answer as an error with status 0.
      else if (!error.status) setFailure({ message: NO_ANSWER, wrongCredentials: false });
      else setFailure({ message: FAILED, wrongCredentials: false });
    } catch {
      // fetch itself failed: the server is down or unreachable.
      setFailure({ message: NO_ANSWER, wrongCredentials: false });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[minmax(0,560px)_minmax(0,1fr)]">
      <BrandPanel />

      <main className="flex flex-1 justify-center px-6 py-8 md:items-center md:p-12">
        <div className="flex w-full max-w-[400px] flex-col gap-6 md:gap-8">
          <div className="flex flex-col gap-2">
            <h1 className="text-[26px] font-semibold tracking-tight md:text-[32px]">Sign in</h1>
            <p className="text-sm leading-normal text-muted md:text-[15px]">
              Use your work email.
            </p>
          </div>

          {failure && (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-[10px] border border-danger-line bg-danger-bg px-3.5 py-3 text-danger-text"
            >
              <svg
                aria-hidden="true"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v5" />
                <path d="M12 16h.01" />
              </svg>
              <span className="text-sm leading-snug">{failure.message}</span>
            </div>
          )}

          <form onSubmit={onSubmit} className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <label htmlFor="email" className="text-sm font-medium">
                Work email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                placeholder="name@company.com"
                className="h-12 rounded-[10px] border border-line bg-white px-3.5 text-base text-ink outline-none placeholder:text-muted focus-visible:border-2 focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-accent-ring"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="password" className="text-sm font-medium">
                Password
              </label>
              <PasswordField
                id="password"
                name="password"
                invalid={failure?.wrongCredentials ?? false}
                describedBy={failure?.wrongCredentials ? "password-hint" : undefined}
              />
              {failure?.wrongCredentials && (
                <span id="password-hint" className="text-[13px] text-muted">
                  Passwords are case-sensitive.
                </span>
              )}
            </div>
            <button
              type="submit"
              disabled={pending}
              className="mt-1 h-12 rounded-[10px] bg-accent text-[15px] font-semibold text-white hover:bg-accent-hover focus-visible:ring-3 focus-visible:ring-accent-ring focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
            >
              {pending ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <div className="flex flex-col gap-1 text-center text-sm text-muted md:text-left">
            <p>HR creates accounts; there is no sign-up.</p>
            <p>Forgot your password? Ask HR to reset it.</p>
          </div>
        </div>
      </main>
    </div>
  );
}

const POINTS = [
  {
    title: "Answers with citations",
    text: "Every answer links the handbook page it is based on.",
    icon: (
      <>
        <path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z" />
        <path d="M4 19V5" />
        <path d="M9 7h6" />
        <path d="M9 11h6" />
      </>
    ),
  },
  {
    title: "Leave and expenses",
    text: "Ask in plain words; your manager approves.",
    icon: (
      <>
        <rect x="3" y="4" width="18" height="17" rx="2" />
        <path d="M3 9h18" />
        <path d="M8 2v4" />
        <path d="M16 2v4" />
        <path d="m9 15 2 2 4-4" />
      </>
    ),
  },
  {
    title: "You see what your role allows",
    text: "Employees, managers and HR each get their own view.",
    icon: (
      <>
        <path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
  },
];

/** Dark product panel: a full column from md up, a short header on phones. */
function BrandPanel() {
  return (
    <section className="flex flex-col gap-5 bg-panel px-6 pt-16 pb-8 text-panel-text md:justify-between md:gap-0 md:px-10 md:py-14 lg:px-16">
      <div className="flex items-center gap-3">
        <div className="flex size-8 items-center justify-center rounded-[9px] bg-accent md:size-9 md:rounded-[10px]">
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#ffffff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l.9-5.4A8 8 0 1 1 21 12z" />
          </svg>
        </div>
        <span className="text-[17px] font-semibold tracking-tight md:text-lg">Company Assistant</span>
      </div>

      <div className="flex flex-col gap-10">
        <p className="text-[26px] leading-[1.15] font-semibold tracking-tight md:text-[36px] md:leading-[1.1] lg:text-[44px]">
          Ask the handbook.
          <br />
          Get the page it came from.
        </p>
        <ul className="hidden flex-col gap-6 md:flex">
          {POINTS.map((point) => (
            <li key={point.title} className="flex items-start gap-4">
              <svg
                aria-hidden="true"
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mt-0.5 shrink-0 text-panel-icon"
              >
                {point.icon}
              </svg>
              <div className="flex flex-col gap-1">
                <span className="text-base font-semibold">{point.title}</span>
                <span className="text-sm leading-normal text-panel-muted">{point.text}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <p className="hidden text-[13px] text-panel-muted md:block">
        Internal tool. Questions about access: contact HR.
      </p>
    </section>
  );
}
