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
    default: "border-[#E4E7EC] bg-white",
    accent: "border-[#B9DFF1] bg-[#F3FAFE]",
    danger: "border-[#FFC2C6] bg-[#FFF7F7]",
  };
  return (
    <div className={`rounded-2xl border p-4 ${tones[tone]} ${className}`}>{children}</div>
  );
}

export function CardTitle({ children }: { children: React.ReactNode }) {
  return <p className="font-sora text-sm font-semibold text-[#0F3449]">{children}</p>;
}

export function Muted({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <p className={`font-work text-xs leading-5 text-[#4B5563] ${className}`}>{children}</p>;
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "primary" | "secondary" | "danger" | "danger-outline" | "ghost";
  size?: "md" | "lg";
};

export function UiButton({ tone = "primary", size = "md", className = "", ...props }: ButtonProps) {
  const tones = {
    primary: "bg-[#2D9CDB] text-white hover:bg-[#2682B6] border-transparent",
    secondary: "bg-white text-[#1E6892] border-[#2D9CDB] hover:bg-[#F3FAFE]",
    danger: "bg-[#FF2635] text-white border-transparent hover:bg-[#E0212F]",
    "danger-outline": "bg-white text-[#FF2635] border-[#FF2635] hover:bg-[#FFF7F7]",
    ghost: "bg-transparent text-[#4B5563] border-transparent hover:text-[#0F3449] underline-offset-4 hover:underline",
  };
  const sizes = { md: "px-3 py-2 text-sm", lg: "px-4 py-3 text-base" };
  return (
    <button
      type="button"
      {...props}
      className={`font-work inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border font-semibold transition-colors disabled:cursor-not-allowed disabled:border-transparent disabled:bg-[#E5E7EB] disabled:text-[#9CA3AF] ${tones[tone]} ${sizes[size]} ${className}`}
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
    info: "bg-[#F3FAFE] text-[#1E6892]",
    error: "bg-[#FFF1F2] text-[#B4121E]",
    success: "bg-[#F0FDF4] text-[#15803D]",
  };
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`font-work rounded-xl px-3 py-2 text-xs leading-5 break-words ${tones[tone]}`}>
      {children}
    </p>
  );
}

export function StatusPill({ tone, children }: { tone: "ok" | "wait" | "bad"; children: React.ReactNode }) {
  const tones = {
    ok: "bg-[#F0FDF4] text-[#15803D]",
    wait: "bg-[#FEF9C3] text-[#854D0E]",
    bad: "bg-[#FFF1F2] text-[#B4121E]",
  };
  const dots = { ok: "bg-[#16A34A]", wait: "bg-[#CA8A04]", bad: "bg-[#DC2626]" };
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
    <p className="rounded-xl bg-[#E3F3FB] px-3 py-3 text-center font-mono text-base font-bold tracking-wider break-all text-[#0F3449]">
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
      className={`focus:border-primary h-24 w-full resize-none rounded-xl border border-[#E4E7EC] p-3 font-mono text-[11px] outline-none ${props.className ?? ""}`}
    />
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`focus:border-primary font-work w-full rounded-xl border border-[#E4E7EC] px-3 py-2.5 text-sm outline-none placeholder:text-[#9CA3AF] ${props.className ?? ""}`}
    />
  );
}
