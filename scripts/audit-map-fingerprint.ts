/**
 * Audit probe: fingerprint every map archetype x size (terrain FNV-1a hash,
 * node counts, keep connectivity) so later changes can be *proven* not to
 * perturb existing maps — saves, replays and campaign seeds must stay stable.
 *
 * Usage: npx tsx scripts/audit-map-fingerprint.ts S,M,L[,XL]
 *        OUT=/path/to.json npx tsx scripts/audit-map-fingerprint.ts ...
 */
import { writeFileSync } from "node:fs";
import { MAPS, startPositions } from "../src/game/constants";
import { GameGrid } from "../src/game/grid";

const sizes = (process.argv[2] ?? "S,M,L").split(",") as Array<
  "S" | "M" | "L" | "XL"
>;
const seeds = (process.env.SEEDS ?? "12345,4242,777").split(",").map(Number);
const out: Record<string, string> = {};

for (const m of MAPS.filter((x) => x.id !== "random")) {
  for (const size of sizes) {
    for (const seed of seeds) {
      const g = new GameGrid(seed, m.id, size, 1);
      let h = 2166136261;
      for (let i = 0; i < g.terrain.length; i++) {
        h ^= g.terrain[i];
        h = Math.imul(h, 16777619);
      }
      const nodes = g.scatterNodes(1);
      const cnt = (k: string) => nodes.filter((n) => n.kind === k).length;
      const [a, b] = startPositions();
      out[`${m.id}/${size}/${seed}`] = [
        `terrain=${(h >>> 0).toString(16)}`,
        `w=${g.w}`,
        `trees=${cnt("tree")}`,
        `rocks=${cnt("rock")}`,
        `gold=${cnt("gold")}`,
        `conn=${g.connected(a.x, a.y, b.x, b.y) ? 1 : 0}`,
      ].join("|");
    }
  }
}

const dest = process.env.OUT ?? "/tmp/map-fingerprints.json";
writeFileSync(dest, JSON.stringify(out, null, 1));
console.log(`wrote ${Object.keys(out).length} fingerprints -> ${dest}`);
