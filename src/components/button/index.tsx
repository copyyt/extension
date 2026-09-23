import React from "react";

const Button = (
  props: React.DetailedHTMLProps<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    HTMLButtonElement
  > & { variant?: "primary" | "outlined" },
) => {
  const variantStyles = {
    primary: "border-transparent text-on-primary bg-primary hover:bg-primary-hover",
    outlined: "border-primary text-primary bg-surface hover:bg-soft",
  };
  return (
    <button
      {...props}
      className={`cursor-pointer rounded-xl border px-4 py-1 leading-6 font-bold transition-colors disabled:bg-disabled disabled:text-on-disabled ${
        variantStyles[props.variant ?? "primary"]
      } ${props.className}`}
    />
  );
};

export default Button;
