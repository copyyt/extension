import React from "react";

const CopyIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <mask
        id="mask0_975_11992"
        style={{ maskType: "alpha" }}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="20"
        height="20"
      >
        <rect width="20" height="20" fill="#D9D9D9" />
      </mask>
      <g mask="url(#mask0_975_11992)">
        <path
          d="M7.5 15C7.04167 15 6.64931 14.8368 6.32292 14.5104C5.99653 14.184 5.83333 13.7917 5.83333 13.3334V3.33335C5.83333 2.87502 5.99653 2.48266 6.32292 2.15627C6.64931 1.82988 7.04167 1.66669 7.5 1.66669H15C15.4583 1.66669 15.8507 1.82988 16.1771 2.15627C16.5035 2.48266 16.6667 2.87502 16.6667 3.33335V13.3334C16.6667 13.7917 16.5035 14.184 16.1771 14.5104C15.8507 14.8368 15.4583 15 15 15H7.5ZM7.5 13.3334H15V3.33335H7.5V13.3334ZM4.16667 18.3334C3.70833 18.3334 3.31597 18.1702 2.98958 17.8438C2.66319 17.5174 2.5 17.125 2.5 16.6667V5.00002H4.16667V16.6667H13.3333V18.3334H4.16667Z"
          fill="white"
        />
      </g>
    </svg>
  );
};

export default CopyIcon;
