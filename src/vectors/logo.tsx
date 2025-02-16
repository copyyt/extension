import React from "react";

const Logo: React.FC<React.SVGProps<SVGSVGElement>> = (props) => {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M21.3332 17.2V22.8C21.3332 27.4666 19.4665 29.3333 14.7998 29.3333H9.19984C4.53317 29.3333 2.6665 27.4666 2.6665 22.8V17.2C2.6665 12.5333 4.53317 10.6666 9.19984 10.6666H14.7998C19.4665 10.6666 21.3332 12.5333 21.3332 17.2Z"
        fill="#2D9CDB"
      />
      <path
        opacity="0.4"
        d="M22.7997 2.66663H17.1997C12.5997 2.66663 10.733 4.49329 10.6797 8.99996H14.7997C20.3997 8.99996 22.9997 11.6 22.9997 17.2V21.32C27.5064 21.2666 29.333 19.4 29.333 14.8V9.19996C29.333 4.53329 27.4664 2.66663 22.7997 2.66663Z"
        fill="#2D9CDB"
      />
    </svg>
  );
};

export default Logo;
