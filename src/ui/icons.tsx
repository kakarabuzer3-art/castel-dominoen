import type { JSX } from "react";
import type { BuildingType, ResKind, UnitType } from "../game/types";

const S = ({ children }: { children: React.ReactNode }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-full h-full"
  >
    {children}
  </svg>
);

export const ResIcon = ({ kind }: { kind: ResKind }): JSX.Element => {
  switch (kind) {
    case "food":
      return (
        <span className="text-[#e8c13c]">
          <S>
            <path d="M12 21c-4 0-7-3-7-8 0-4 3-9 7-9s7 5 7 9c0 5-3 8-7 8z" fill="#e8a33c55" />
            <path d="M12 4v17" />
            <path d="M12 9c2-1.5 4-1.5 5.5-2.5" />
            <path d="M12 13c-2-1.5-4-1.5-5.5-2.5" />
          </S>
        </span>
      );
    case "wood":
      return (
        <span className="text-[#a3e07a]">
          <S>
            <rect x="3" y="8" width="18" height="8" rx="4" fill="#8a6a3a66" />
            <ellipse cx="7" cy="12" rx="2.4" ry="4" />
            <path d="M7 10.5v3" />
            <path d="M11 8.5c2 1 4 1 6 0M11 15.5c2-1 4-1 6 0" />
          </S>
        </span>
      );
    case "stone":
      return (
        <span className="text-[#cfd4dd]">
          <S>
            <path d="M4 16l3-8 6-3 7 5-2 8-8 2z" fill="#9aa0a855" />
            <path d="M7 8l5 4 8-1M12 12l-2 10" />
          </S>
        </span>
      );
    case "gold":
      return (
        <span className="text-[#ffd166]">
          <S>
            <circle cx="12" cy="12" r="8" fill="#e6b93c55" />
            <circle cx="12" cy="12" r="4.5" />
            <path d="M12 3v2M12 19v2M3 12h2M19 12h2" />
          </S>
        </span>
      );
    default:
      return <span />;
  }
};

export const UnitIcon = ({ type }: { type: UnitType }): JSX.Element => {
  switch (type) {
    case "villager":
      return (
        <S>
          <circle cx="12" cy="7" r="3.2" fill="#e2b48d55" />
          <path d="M12 10.5c-3 0-5 2-5 5V21h10v-5.5c0-3-2-5-5-5z" fill="#b98d5f55" />
          <path d="M17 6l4-3M20.5 4.5L19 6l1.5 1.5" />
        </S>
      );
    case "militia":
      return (
        <S>
          <path d="M12 2l2 8-2 2-2-2z" fill="#d8dde455" />
          <path d="M12 12v7" />
          <path d="M8.5 15.5h7" />
          <path d="M9 21h6" />
        </S>
      );
    case "spearman":
      return (
        <S>
          <path d="M6 21L18 4" />
          <path d="M18 4l1.5 3.5L16 6.5z" fill="#d8dde455" />
          <circle cx="7.5" cy="16" r="3.4" fill="#b8ae9a55" />
        </S>
      );
    case "archer":
      return (
        <S>
          <path d="M5 20C3 14 6 6 14 4" />
          <path d="M5 20l14-14" />
          <path d="M14 4l1 4 4-1" />
          <path d="M5 20l4-1-1 4" />
        </S>
      );
    case "knight":
      return (
        <S>
          <path d="M4 18c1-5 4-8 9-8l3-4 3 2-2 3c2 1 3 4 3 7z" fill="#6b4a2c55" />
          <circle cx="13" cy="7" r="2.6" fill="#9aa0a855" />
          <path d="M3 21h18" />
        </S>
      );
    case "catapult":
      return (
        <S>
          <path d="M4 16h13" />
          <circle cx="7" cy="19" r="2.4" />
          <circle cx="15" cy="19" r="2.4" />
          <path d="M8 16L17 5" />
          <circle cx="17.5" cy="4.5" r="2" fill="#8f897c55" />
        </S>
      );
    default:
      return <span />;
  }
};

export const BuildIcon = ({ type }: { type: BuildingType }): JSX.Element => {
  switch (type) {
    case "house":
      return (
        <S>
          <path d="M4 11l8-7 8 7" />
          <path d="M6 10v10h12V10" fill="#c7a06b33" />
          <path d="M10 20v-6h4v6" />
        </S>
      );
    case "farm":
      return (
        <S>
          <rect x="3" y="10" width="18" height="11" rx="1" fill="#7c5a3455" />
          <path d="M3 14h18M3 17.5h18" />
          <path d="M7 10c0-2 1.5-4 1.5-4s1.5 2 1.5 4M14 10c0-2 1.5-4 1.5-4s1.5 2 1.5 4" />
        </S>
      );
    case "barracks":
      return (
        <S>
          <path d="M3 10l9-6 9 6" />
          <rect x="4.5" y="10" width="15" height="10" fill="#8d857855" />
          <path d="M9 20v-5h6v5" />
          <path d="M7 8l3-6M17 8l-3-6" />
        </S>
      );
    case "wall":
      return (
        <S>
          <rect x="3" y="9" width="18" height="11" fill="#8d857a55" />
          <path d="M3 9v-3h4v3M10 9V6h4v3M17 9V6h4v3" />
          <path d="M3 14h18M9 14v6M15 9v5" />
        </S>
      );
    case "gate":
      return (
        <S>
          <rect x="3" y="8" width="18" height="12" fill="#8d857a55" />
          <path d="M3 8V5h4v3M17 8V5h4v3" />
          <path d="M8 20v-7a4 4 0 0 1 8 0v7z" fill="#5c402355" />
          <path d="M8 14h8" />
        </S>
      );
    case "tower":
      return (
        <S>
          <path d="M8 21V7h8v14z" fill="#9a928555" />
          <path d="M8 7V4h2v2h4V4h2v3" />
          <path d="M12 12v4" />
          <path d="M6 21h12" />
        </S>
      );
    case "lumbercamp":
      return (
        <S>
          <circle cx="8" cy="16" r="3" fill="#8a6a3a55" />
          <circle cx="14" cy="16" r="3" fill="#8a6a3a55" />
          <circle cx="11" cy="11" r="3" fill="#8a6a3a55" />
          <path d="M4 21h16" />
          <path d="M17 8l4-4M19.5 6.5L18 5" />
        </S>
      );
    case "quarry":
      return (
        <S>
          <rect x="4" y="14" width="7" height="5" fill="#b0a89855" />
          <rect x="12" y="14" width="7" height="5" fill="#b0a89855" />
          <rect x="8" y="9" width="7" height="5" fill="#b0a89855" />
          <path d="M3 21h18" />
        </S>
      );
    case "market":
      return (
        <S>
          <path d="M4 9l2-5h12l2 5z" fill="#c94f3f33" />
          <path d="M4 9h16" />
          <path d="M6 9v11h12V9" />
          <path d="M9 20v-5h6v5" />
        </S>
      );
    case "shrine":
      return (
        <S>
          <path d="M9 21v-9h6v9z" fill="#b0a89855" />
          <path d="M8 12h8l-1-3H9z" />
          <circle cx="12" cy="6" r="2.4" fill="#ffe08a55" />
          <path d="M6 21h12" />
        </S>
      );
    case "granary":
      return (
        <S>
          <path d="M8 21V10a4 4 0 0 1 8 0v11z" fill="#c9a06b44" />
          <path d="M6 21h12" />
          <path d="M8 13h8M8 17h8" />
          <path d="M12 6V3" />
        </S>
      );
    case "inn":
      return (
        <S>
          <path d="M9 8h7v12H9z" fill="#c9a06b44" />
          <path d="M16 10h3a2 2 0 0 1 0 6h-3" />
          <path d="M9 8l1-3h5l1 3" />
          <path d="M11 12v4M13.5 12v4" />
        </S>
      );
    case "keep":
      return (
        <S>
          <path d="M4 21V9l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1v12z" fill="#a29a8c55" />
          <path d="M10 21v-5h4v5" />
          <path d="M12 3v4M12 3l4 1.5-4 1.5" />
        </S>
      );
    default:
      return <span />;
  }
};

export const PopIcon = (): JSX.Element => (
  <span className="text-[#8fb7ff]">
    <S>
      <circle cx="9" cy="8" r="3" />
      <path d="M4 20c0-3.3 2.2-5.5 5-5.5s5 2.2 5 5.5" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M15.5 14.8c2.6.2 4.5 2.2 4.5 5.2" />
    </S>
  </span>
);

export const HappyIcon = ({ level }: { level: number }): JSX.Element => {
  const color = level >= 75 ? "#8ce08a" : level <= 35 ? "#e0705c" : "#e8c877";
  return (
    <span style={{ color }}>
      <S>
        <circle cx="12" cy="12" r="9" fill={color + "33"} />
        <circle cx="9" cy="10" r="0.9" fill={color} />
        <circle cx="15" cy="10" r="0.9" fill={color} />
        {level >= 75 ? (
          <path d="M8 14c1.2 1.8 2.6 2.6 4 2.6s2.8-.8 4-2.6" />
        ) : level <= 35 ? (
          <path d="M8 16.5c1.2-1.8 2.6-2.6 4-2.6s2.8.8 4 2.6" />
        ) : (
          <path d="M8.5 15h7" />
        )}
      </S>
    </span>
  );
};
