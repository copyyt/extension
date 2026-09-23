import React from "react";

/** Small, consistent building blocks for the popup (Copyyt colours and fonts). */

export function Card({
  children,
  tone = "default",
  className = "",
}: {
  children: React.ReactNode;
  tone?: "default" | "accent" | "danger";
  className?: string;
}) {
  const tones = {
    default: "border-line bg-surface",
    accent: "border-primary bg-soft",
    danger: "border-danger bg-danger-soft",
  };
  return (
    <div className={`rounded-2xl border p-4 ${tones[tone]} ${className}`}>{children}</div>
  );
}

export function CardTitle({ children }: { children: React.ReactNode }) {
  return <p className="font-sora text-sm font-semibold text-ink">{children}</p>;
}

export function Muted({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <p className={`font-work text-xs leading-5 text-muted ${className}`}>{children}</p>;
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "primary" | "secondary" | "danger" | "danger-outline" | "ghost";
  size?: "md" | "lg";
};

export function UiButton({ tone = "primary", size = "md", className = "", ...props }: ButtonProps) {
  const tones = {
    primary: "bg-primary text-on-primary hover:bg-primary-hover border-transparent",
    secondary: "bg-surface text-primary border-primary hover:bg-soft",
    danger: "bg-danger text-on-danger border-transparent hover:opacity-85",
    "danger-outline": "bg-surface text-danger border-danger hover:bg-danger-soft",
    ghost: "bg-transparent text-muted border-transparent hover:text-ink underline-offset-4 hover:underline",
  };
  const sizes = { md: "px-3 py-2 text-sm", lg: "px-4 py-3 text-base" };
  return (
    <button
      type="button"
      {...props}
      className={`font-work inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border font-semibold transition-colors disabled:cursor-not-allowed disabled:border-transparent disabled:bg-disabled disabled:text-on-disabled ${tones[tone]} ${sizes[size]} ${className}`}
    />
  );
}

export function Alert({
  tone = "info",
  children,
}: {
  tone?: "info" | "error" | "success";
  children: React.ReactNode;
}) {
  const tones = {
    info: "bg-soft text-primary",
    error: "bg-danger-soft text-on-danger-soft",
    success: "bg-success-soft text-on-success-soft",
  };
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`font-work rounded-xl px-3 py-2 text-xs leading-5 break-words ${tones[tone]}`}>
      {children}
    </p>
  );
}

export function StatusPill({ tone, children }: { tone: "ok" | "wait" | "bad"; children: React.ReactNode }) {
  const tones = {
    ok: "bg-success-soft text-on-success-soft",
    wait: "bg-warning-soft text-on-warning-soft",
    bad: "bg-danger-soft text-on-danger-soft",
  };
  const dots = { ok: "bg-success", wait: "bg-warning", bad: "bg-danger" };
  return (
    <span className={`font-work inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${tones[tone]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dots[tone]}`} />
      {children}
    </span>
  );
}

/** The pairing code, large and easy to compare. */
export function Fingerprint({ value }: { value: string }) {
  return (
    <p className="rounded-xl bg-soft px-3 py-3 text-center font-mono text-base font-bold tracking-wider break-all text-ink">
      {value}
    </p>
  );
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      autoComplete="off"
      spellCheck={false}
      {...props}
      className={`focus:border-primary bg-surface text-ink placeholder:text-muted h-24 w-full resize-none rounded-xl border border-line p-3 font-mono text-[11px] outline-none ${props.className ?? ""}`}
    />
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`focus:border-primary bg-surface text-ink placeholder:text-muted font-work w-full rounded-xl border border-line px-3 py-2.5 text-sm outline-none ${props.className ?? ""}`}
    />
  );
}
