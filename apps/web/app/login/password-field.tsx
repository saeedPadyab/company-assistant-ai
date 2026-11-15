"use client";

import { useState } from "react";

type Props = {
  id: string;
  name: string;
  invalid: boolean;
  describedBy?: string;
};

/** Password input with a show/hide button whose accessible name follows its state. */
export function PasswordField({ id, name, invalid, describedBy }: Props) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative flex">
      <input
        id={id}
        name={name}
        type={visible ? "text" : "password"}
        required
        autoComplete="current-password"
        aria-invalid={invalid}
        aria-describedby={describedBy}
        className={`h-12 w-full rounded-[10px] border bg-white pr-13 pl-3.5 text-base text-ink outline-none focus-visible:border-2 focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-accent-ring ${
          invalid ? "border-2 border-danger" : "border-line"
        }`}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        aria-controls={id}
        className="absolute top-0.5 right-0.5 flex size-11 items-center justify-center rounded-lg text-muted hover:text-ink focus-visible:ring-3 focus-visible:ring-accent-ring focus-visible:outline-none"
      >
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
          {visible && <path d="M3 3l18 18" />}
        </svg>
      </button>
    </div>
  );
}
