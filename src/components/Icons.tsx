// Small stroke icons, 16px grid, drawn with currentColor.

import { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 14, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconBranch = (p: P) => (
  <Svg {...p}>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="11.5" cy="5.5" r="1.5" />
    <path d="M4.5 5v6M11.5 7c0 3-7 2-7 4" />
  </Svg>
);

export const IconCloud = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 12.5h7a3 3 0 0 0 .4-6A4 4 0 0 0 4.2 7.2a2.7 2.7 0 0 0 .3 5.3z" />
  </Svg>
);

export const IconLaptop = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3.5" width="10" height="7" rx="1" />
    <path d="M1.5 12.5h13" />
  </Svg>
);

export const IconTag = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 2.5h5l6 6-5 5-6-6z" />
    <circle cx="5.5" cy="5.5" r="1" />
  </Svg>
);

export const IconPullRequest = (p: P) => (
  <Svg {...p}>
    <circle cx="4" cy="3.5" r="1.5" />
    <circle cx="4" cy="12.5" r="1.5" />
    <circle cx="12" cy="12.5" r="1.5" />
    <path d="M4 5v6M12 11V6.5a2 2 0 0 0-2-2H7.5M9 3l-1.5 1.5L9 6" />
  </Svg>
);

export const IconTerminal = (p: P) => (
  <Svg {...p}>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
    <path d="M4.5 6l2 2-2 2M8.5 10.5h3" />
  </Svg>
);

export const IconWorkspace = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="2" width="5" height="5" rx="1" />
    <rect x="9" y="2" width="5" height="5" rx="1" />
    <rect x="2" y="9" width="5" height="5" rx="1" />
    <rect x="9" y="9" width="5" height="5" rx="1" />
  </Svg>
);

export const IconStash = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="3" width="11" height="3" rx="0.8" />
    <path d="M3.5 6v6.5h9V6M6.5 9h3" />
  </Svg>
);

export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="M3 8.5l3 3 7-7" />
  </Svg>
);

export const IconPull = (p: P) => (
  <Svg {...p}>
    <path d="M8 2.5v9M4.5 8l3.5 3.5L11.5 8M3 13.5h10" />
  </Svg>
);

export const IconPush = (p: P) => (
  <Svg {...p}>
    <path d="M8 13.5v-9M4.5 8L8 4.5 11.5 8M3 2.5h10" />
  </Svg>
);

export const IconFetch = (p: P) => (
  <Svg {...p}>
    <path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3" />
  </Svg>
);

export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);

export const IconMinus = (p: P) => (
  <Svg {...p}>
    <path d="M3 8h10" />
  </Svg>
);

export const IconChevron = (p: P & { open?: boolean }) => {
  const { open, style, ...rest } = p;
  // A caller's own rotation (a down or left arrow) is kept when closed.
  return (
    <Svg {...rest} style={{ ...style, transform: open ? "rotate(90deg)" : style?.transform, transition: "transform 120ms" }}>
      <path d="M6 3.5l4.5 4.5L6 12.5" />
    </Svg>
  );
};

export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);

export const IconFolder = (p: P) => (
  <Svg {...p}>
    <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
  </Svg>
);

export const IconUndo = (p: P) => (
  <Svg {...p}>
    <path d="M5 4.5L2.5 7 5 9.5M2.5 7H10a3.5 3.5 0 0 1 0 7H8" />
  </Svg>
);

export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" />
  </Svg>
);

export const IconRefresh = (p: P) => (
  <Svg {...p}>
    <path d="M13 3v3.5H9.5M3 13V9.5h3.5" />
    <path d="M12.6 6.5A5 5 0 0 0 3.6 5M3.4 9.5a5 5 0 0 0 9 1.5" />
  </Svg>
);

export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5l3 3" />
  </Svg>
);

export const IconFile = (p: P) => (
  <Svg {...p}>
    <path d="M4 1.5h5l3 3v10H4z M9 1.5v3h3" />
  </Svg>
);

export const IconPop = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="9" width="11" height="4.5" rx="0.8" />
    <path d="M8 7.5V1.5M5.5 4L8 1.5 10.5 4" />
  </Svg>
);

export const IconSettings = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.8v1.7M8 12.5v1.7M14.2 8h-1.7M3.5 8H1.8M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2M12.4 12.4l-1.2-1.2M4.8 4.8L3.6 3.6" />
  </Svg>
);

export const IconEye = (p: P) => (
  <Svg {...p}>
    <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="2" />
  </Svg>
);

export const IconEyeOff = (p: P) => (
  <Svg {...p}>
    <path d="M2 2l12 12M6.6 3.7A6.8 6.8 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.9 2.5M4.2 5A11 11 0 0 0 1.5 8S4 12.5 8 12.5c.9 0 1.8-.2 2.6-.6" />
  </Svg>
);

export const IconBell = (p: P) => (
  <Svg {...p}>
    <path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3z" />
    <path d="M6.5 14a1.5 1.5 0 0 0 3 0" />
  </Svg>
);

export const IconUser = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="5.5" r="2.5" />
    <path d="M3 13.5a5 5 0 0 1 10 0" />
  </Svg>
);

export const IconAlert = (p: P) => (
  <Svg {...p}>
    <path d="M8 2 14.5 13.5h-13z" />
    <path d="M8 6.5v3M8 11.5v.01" />
  </Svg>
);

export const IconActivity = (p: P) => (
  <Svg {...p}>
    <path d="M1.5 8h3l2-4.5 3 9 2-4.5h3" />
  </Svg>
);

export const IconIssue = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <circle cx="8" cy="8" r="1" fill="currentColor" />
  </Svg>
);
