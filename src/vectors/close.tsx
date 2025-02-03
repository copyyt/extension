import React from "react";

const CloseIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <mask
        id="mask0_974_11903"
        style={{ maskType: "alpha" }}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="24"
        height="24"
      >
        <rect width="24" height="24" fill="#D9D9D9" />
      </mask>
      <g mask="url(#mask0_974_11903)">
        <path
          d="M6.39953 18.6553L5.3457 17.6015L10.9457 12.0015L5.3457 6.40148L6.39953 5.34766L11.9995 10.9477L17.5995 5.34766L18.6534 6.40148L13.0534 12.0015L18.6534 17.6015L17.5995 18.6553L11.9995 13.0553L6.39953 18.6553Z"
          fill="#6B7280"
        />
      </g>
    </svg>
  );
};

export default CloseIcon;
