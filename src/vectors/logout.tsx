import React from "react";

const LogoutIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M7.41675 6.29995C7.67508 3.29995 9.21675 2.07495 12.5917 2.07495H12.7001C16.4251 2.07495 17.9167 3.56662 17.9167 7.29162V12.725C17.9167 16.45 16.4251 17.9416 12.7001 17.9416H12.5917C9.24175 17.9416 7.70008 16.7333 7.42508 13.7833"
        stroke="#FF2635"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12.4999 10H3.0166"
        stroke="#FF2635"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4.87492 7.20837L2.08325 10L4.87492 12.7917"
        stroke="#FF2635"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

export default LogoutIcon;
