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
        <label className="font-work mb-3 block text-sm" htmlFor={props.id}>
          {props.label}
        </label>
      ) : null}

      <input
        {...props}
        className={`focus:border-primary rounded-xl border border-[#E4E7EC] p-4 font-medium outline-none placeholder:text-[#9CA3AF] ${props.className} w-full`}
      />
    </div>
  );
};
