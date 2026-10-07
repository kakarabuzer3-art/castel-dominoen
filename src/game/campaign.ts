import type {
  BuildingType,
  ResKind,
  Resources,
  UnitType,
} from "./types";
import type { Difficulty, MapArch, MapSize } from "./constants";

export interface ObjectiveDef {
  id: string;
  label: string;
  kind: "destroyKeep" | "destroyType" | "build" | "train" | "gather" | "kill" | "survive";
  type?: BuildingType | UnitType;
  res?: ResKind;
  n?: number;
  primary: boolean;
}

export interface MissionEvent {
  t: number;
  kind: "msg" | "wave" | "reinforce" | "ford" | "attrition";
  text?: string;
  n?: number;
  types?: UnitType[];
}

export interface MissionDef {
  id: number;
  name: string;
  briefing: string;
  map: MapArch;
  size: MapSize;
  lord: number;
  difficulty: Difficulty;
  startRes: 0 | 1 | 2;
  playerStart?: {
    units?: Array<[UnitType, number, number]>;
    buildings?: Array<[BuildingType, number, number]>;
    res?: Partial<Resources>;
  };
  enemyStart?: {
    units?: Array<[UnitType, number, number]>;
    buildings?: Array<[BuildingType, number, number]>;
  };
  objectives: ObjectiveDef[];
  events: MissionEvent[];
  aiPassiveUntil?: number;
  keepHpMult?: number;
}

export const MISSIONS: MissionDef[] = [
  {
    id: 0,
    name: "I — The Founding",
    briefing:
      "You have crossed the mountains with four loyal peasants. Establish a homestead: raise houses and a farm, grow your population, then burn out the bandit camp that terrorises the valley.",
    map: "verdant",
    size: "S",
    lord: 1,
    difficulty: 0,
    startRes: 2,
    enemyStart: {
      // an isolated bandit camp in the mid-map valley (offsets from enemy keep)
      buildings: [["barracks", -40, 40]],
      units: [
        ["militia", -41, 42],
        ["militia", -39, 42],
        ["archer", -40, 43],
      ],
    },
    objectives: [
      { id: "h2", label: "Build 2 Houses", kind: "build", type: "house", n: 2, primary: true },
      { id: "f1", label: "Build a Farm", kind: "build", type: "farm", n: 1, primary: true },
      { id: "v3", label: "Train 3 Villagers", kind: "train", type: "villager", n: 3, primary: true },
      { id: "camp", label: "Destroy the bandit camp (enemy barracks)", kind: "destroyType", type: "barracks", n: 1, primary: true },
    ],
    events: [
      { t: 30, kind: "msg", text: "Scouts: the bandit camp lies to the north-east." },
      { t: 240, kind: "wave", n: 3, types: ["militia", "militia", "archer"] },
    ],
    aiPassiveUntil: 600,
  },
  {
    id: 1,
    name: "II — The River War",
    briefing:
      "The river divides your realm from Lord Vharek's raiders. Hold the bridges, field an army of eight, blood them against his warbands, then cross and end him.",
    map: "riverlands",
    size: "M",
    lord: 0,
    difficulty: 1,
    startRes: 1,
    keepHpMult: 0.6,
    playerStart: {
      buildings: [["tower", 6, -5]],
      units: [
        ["militia", 3, 7],
        ["militia", 4, 7],
      ],
    },
    objectives: [
      { id: "army", label: "Field an army of 8 military units", kind: "train", type: "militia", n: 8, primary: true },
      { id: "kill15", label: "Slay 15 enemies", kind: "kill", n: 15, primary: true },
      { id: "keep", label: "Destroy the enemy keep", kind: "destroyKeep", primary: true },
    ],
    events: [
      { t: 180, kind: "msg", text: "Raiders mass at the far bridge!" },
      { t: 240, kind: "wave", n: 4, types: ["militia", "militia", "spearman", "archer"] },
      { t: 460, kind: "wave", n: 5, types: ["militia", "knight", "archer", "archer", "spearman"] },
      { t: 300, kind: "reinforce", n: 2, types: ["knight", "knight"] },
      { t: 620, kind: "reinforce", n: 4, types: ["knight", "knight", "catapult", "catapult"] },
      { t: 700, kind: "ford", text: "The drought reveals a shallow crossing mid-river!" },
      { t: 980, kind: "reinforce", n: 4, types: ["militia", "militia", "archer", "catapult"] },
    ],
  },
  {
    id: 2,
    name: "III — Sands of Trial",
    briefing:
      "Lady Morwen tests you: endure her sieges for six minutes beneath the desert sun, then take her fortress of sand and stone.",
    map: "desert",
    size: "M",
    lord: 1,
    difficulty: 1,
    startRes: 2,
    keepHpMult: 0.5,
    playerStart: {
      buildings: [
        ["wall", 8, -6],
        ["wall", 9, -6],
        ["wall", 10, -6],
        ["wall", 12, -6],
        ["wall", 13, -6],
        ["gate", 11, -6],
        ["tower", 7, -5],
        ["tower", 14, -5],
      ],
      units: [
        ["militia", 4, 7],
        ["militia", 5, 7],
        ["archer", 6, 7],
        ["archer", 7, 7],
      ],
    },
    objectives: [
      { id: "hold", label: "Hold the fortress for 6 minutes", kind: "survive", n: 360, primary: true },
      { id: "keep", label: "Destroy the enemy keep", kind: "destroyKeep", primary: true },
    ],
    events: [
      { t: 90, kind: "wave", n: 5, types: ["militia", "militia", "spearman", "archer", "archer"] },
      { t: 240, kind: "wave", n: 5, types: ["militia", "militia", "knight", "archer", "archer"] },
      { t: 330, kind: "wave", n: 4, types: ["militia", "knight", "archer", "spearman"] },
      { t: 360, kind: "msg", text: "Her siege trains are spent. TAKE THE FORTRESS!" },
      { t: 380, kind: "attrition", text: "Scouts: the garrison is exhausted and bleeding!" },
      { t: 420, kind: "reinforce", n: 4, types: ["knight", "knight", "catapult", "catapult"] },
      { t: 780, kind: "reinforce", n: 4, types: ["militia", "militia", "archer", "catapult"] },
    ],
  },
  {
    id: 3,
    name: "IV — The Ember Throne",
    briefing:
      "Vharek the Ember crowns himself in the old capital. March across the great valley, break his hosts in the field, and unmake his keep. The realm holds its breath.",
    map: "verdant",
    size: "M",
    lord: 0,
    difficulty: 2,
    startRes: 2,
    keepHpMult: 0.6,
    playerStart: {
      units: [
        ["militia", 3, 7],
        ["militia", 4, 7],
        ["archer", 5, 7],
        ["archer", 6, 7],
      ],
    },
    objectives: [
      { id: "kill40", label: "Slay 40 enemies", kind: "kill", n: 40, primary: false },
      { id: "keep", label: "Destroy the Ember Keep", kind: "destroyKeep", primary: true },
    ],
    events: [
      { t: 300, kind: "msg", text: "The Ember host marches!" },
      { t: 330, kind: "wave", n: 7, types: ["militia", "militia", "knight", "knight", "archer", "archer", "spearman"] },
      { t: 540, kind: "wave", n: 8, types: ["militia", "militia", "knight", "knight", "archer", "archer", "spearman", "catapult"] },
      { t: 700, kind: "reinforce", n: 4, types: ["knight", "knight", "catapult", "catapult"] },
      { t: 1000, kind: "reinforce", n: 4, types: ["militia", "militia", "archer", "catapult"] },
    ],
  },
];

export const CAMPAIGN_KEY = "castle-dominion-campaign-v1";

export function campaignProgress(): number {
  try {
    if (typeof localStorage === "undefined") return 0;
    return Number(localStorage.getItem(CAMPAIGN_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

export function setCampaignProgress(next: number): void {
  try {
    if (typeof localStorage !== "undefined")
      localStorage.setItem(CAMPAIGN_KEY, String(next));
  } catch {
    /* ignore */
  }
}
