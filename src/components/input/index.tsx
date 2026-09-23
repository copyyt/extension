import React from "react";

export const InputField = (
  props: React.DetailedHTMLProps<
    React.InputHTMLAttributes<HTMLInputElement>,
    HTMLInputElement
  > & { label?: string },
) => {
  return (
    <div className="w-full">
      {props.label ? (
        <label className="font-work mb-3 block text-sm text-ink" htmlFor={props.id}>
          {props.label}
        </label>
      ) : null}

      <input
        {...props}
        className={`focus:border-primary bg-surface text-ink placeholder:text-muted w-full rounded-xl border border-line p-4 font-medium outline-none ${props.className ?? ""}`}
      />
    </div>
  );
};
