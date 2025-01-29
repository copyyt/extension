import React from "react";

const Button = (
  props: React.DetailedHTMLProps<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    HTMLButtonElement
  > & { variant?: "primary" | "outlined" },
) => {
  const variantStyles = {
    primary: "border-transparent text-white bg-primary",
    outlined: "border-primary text-primary bg-white",
  };
  return (
    <button
      {...props}
      className={`cursor-pointer rounded-xl border px-4 py-1 leading-6 font-bold transition-all duration-300 hover:opacity-45 ${
        variantStyles[props.variant ?? "primary"]
      } ${props.className}`}
    />
  );
};

export default Button;
