# Castle of Minds — Concept (working title)

> **You don't just run a kingdom. You run its people's minds.**

Status: Phase 0 concept lock. The name is a **working title** — no trademark or
store-name search has been done yet (see "Open items").

## The one-paragraph pitch

A premium, single-player medieval castle strategy game. Walls and armies still
matter, but the real battlefield is **morale, rumor and trust**. Every villager
is a named person with a personality, needs and memories. News spreads through
the village's social ties, not through a global number. A castle can fall because
its walls broke — or because its people lost the will to hold them.

## How it differs from the current codebase (Castle Dominion)

| | Today (Castle Dominion) | Castle of Minds |
|---|---|---|
| Mood | one popularity number (0–100) per kingdom | each villager has traits, needs, mood and memories |
| How a castle falls | destroy the keep | break the walls **or** break the will (hunger, fear, rumor, surrender terms) |
| Information | everyone knows everything | rumors travel through social ties; spies and truth are different things |
| Advice | none | a council whose advisors can be wrong and have their own agendas |
| Decisions | resource trade-offs | moral dilemmas whose consequences return later |
| Enemy AI | scripted waves; Brutal gets extra income | goal-driven lords that only know what they have seen — no resource cheating |

The simulation, renderers, tests and multiplayer relay already in the repo are
the foundation; this game is built on them, not from scratch.

## Design pillars

1. **People, not numbers.** You can always ask "why is this person unhappy?" and get a true answer.
2. **Many ways to win.** Force, siege, starvation, diplomacy, rumor, mercy.
3. **Fair and legible difficulty.** The AI is hard because it is smart, not because it cheats. A loss should be explainable ("I ignored the granary"), never "the AI had free gold".
4. **Deterministic by construction.** Seeded RNG, replays, save/load and (later) multiplayer stay hash-identical. Every new system must be part of `serialize()` / `stateHash()`.
5. **Respect the player.** Premium game, one price. No loot boxes, no fake-urgency timers, no daily-login pressure, no nagging notifications, analytics only if opt-in.

## Psychology → mechanics

| Principle | In the game |
|---|---|
| Autonomy / competence / relatedness (Self-Determination Theory) | several viable win paths; a "why did that happen" panel after outcomes; named people you come to care about |
| Flow | difficulty rises through smarter opponents; threats are telegraphed so a loss feels like *my* mistake |
| Loss aversion | named villagers and buildings can be lost — and it hurts, by design |
| Zeigarnik effect (unfinished business pulls attention) | open petitions and story threads |
| Peak–end rule | every match ends with a "Chronicle": your story, key moments, shareable |

These are well-known design heuristics, used here to make the game *clearer and
more meaningful*. They are not used to extract extra playtime or spending.

## Scope for v1 (so it actually ships)

- **Single-player only.** Multiplayer (already prototyped) returns after launch as an update.
- 4 lords, 6 existing map archetypes, a 6–8 mission campaign.
- ~50–100 *named* villagers per match; the rest of the crowd is simulated in aggregate.
- 3D renderer as the primary view; the 2D renderer stays as fallback.

## Performance budget

Minimum-spec target: a **laptop with 8 GB RAM and integrated graphics** must hold
a smooth frame rate on a medium map at default settings. Real numbers come from
the in-game **F3 profiler** on real hardware (headless CI numbers are only
liveness floors). The adaptive quality governor (`src/game/perf.ts`) is the safety net.

## Asset and license policy

- Only assets we may use **commercially**. No "non-commercial" (CC-NC) licenses.
- Every third-party asset is recorded with source URL and license before it is committed.
- AI-generated assets only after reading the generator's current commercial-use terms.
- A `THIRD_PARTY_LICENSES` file is compiled before release (Phase 8).

## Open items (not done yet)

- [ ] Final name + trademark / store-name search (needs a proper search, not a guess).
- [ ] Baseline FPS number on a real minimum-spec laptop (F3 profiler).
- [ ] Decide the release channel (Steam / itch.io / own site) and price (Phase 8).

## Status

| Phase | State |
|---|---|
| 0 — foundation (concept, AI save/load fix, hardened MP relay) | done, merged to `main` (PR #1) |
| 2 — minds v1 (named villagers) | done, pushed on `phase-2-minds` — see below |
| 3a — first gameplay effect: mood sets work speed | done on branch `phase-3a-morale-work` — see below |
| 1 — 3D look (postprocessing, glTF models) | **not started**: needs `npm install` of new packages and a real browser to judge the result |
| 3b — rumor and morale (social ties, rumors, surrender terms) | next |

### Phase 2 — what exists

- `src/game/minds.ts`: up to 100 named villagers per team. Each has a name, two
  traits (of 8), four needs (food / safety / company / purpose), a mood and up to
  four memories. Needs are driven by the real world: rations, famine, enemy
  soldiers nearby, shrines, inns, neighbours, whether the person has work, taxes,
  grief, recent deaths they witnessed.
- "Why?" is honest by construction: the explanation list is the same set of
  numbers that produces the mood (`test:minds` asserts `mood == clamp(50 + sum(why))`
  for every person).
- HUD: the Popularity drawer gains a "People" section (`src/ui/MindSection.tsx`).
  Select one villager to see who they are and why they feel as they do; with no
  villager selected it shows the village mood and the unhappiest people.
- **v1 is observational on purpose.** It reads the simulation and changes
  nothing: it never touches the RNG, is not part of `stateHash()`, and a match
  with the mind layer switched off ends in a bit-identical state (proved by
  `test:minds`, including a scripted brawl with 30+ casualties). The recorded
  behaviour fingerprints therefore still match. Moods start to matter in Phase 3,
  where each gameplay effect will come with a deliberate, reviewed fingerprint
  rebaseline instead of a silent balance change.
- Deterministic and saved: names/traits are a pure function of (match seed, unit
  id); minds are written into saves and replay checkpoints; old saves load and
  simply start fresh.

### Phase 3a — mood sets work speed (the first effect on gameplay)

- A villager's mood now scales how fast they harvest and build:
  `x = 1 + 0.006 * (mood - 55)`, clamped to **0.75 .. 1.10** (`WORK` /
  `workFromMood` in `minds.ts`). Calm baseline (mood 55) is exactly x1.00; named
  villagers use their own mood, the anonymous crowd uses the team's average mood
  (cached once per second and saved). Built from `+ - * /` only, so every peer
  computes bit-identical numbers. The People panel shows "Work speed x1.xx".
- Minds are therefore **simulation state now**: part of `stateHash()` and saved
  exactly. They still never touch the sim RNG, and contain no seat-dependent code
  (so multiplayer/replay hashes stay seat-independent; `test:mp` shows 0 desyncs).
- **Proved to be the only gameplay change of the effect itself:** with the
  multiplier forced to 1.0, seed 12345 ends in victory at 765 s — identical to the
  Phase 2 baseline. Applied to only one team, games still end normally.
- **It exposed a pre-existing AI flaw, now fixed.** The AI capped itself at 10
  houses (= population cap 68). A popular kingdom is flooded by immigrants, so in
  long games the AI sat at 68/68 with ~50 villagers and almost no soldiers, and
  two of the three `sim` seeds stalled for 45 minutes (the README promises matches
  always conclude). The house limit is now 18 (epic: 26). After the fix the same
  seeds conclude (the scripted test bot is beaten at ~2050 s: AI now closes games).
- **Fingerprints were rebaselined on purpose** (`scripts/fixtures/sim-fingerprints.json`).
  Reviewed diff: the AI team gathers ~10-25% more in the idle scenarios (content
  villagers work up to 10% faster); terrain fingerprints are untouched.
- Not tuned for fun: the numbers are a first guess. Against a scripted bot the
  AI now wins long games it used to stall on; whether that feels fair to a human
  needs real playtesting.

### Not verified yet

- `MindSection.tsx` has **not been seen in a browser** (no browser or React type
  packages in the authoring environment); `tsc` shows only the usual
  missing-@types noise for it. Please check it on screen, and run `npm ci && npm test`.
- Balance of the mood numbers is untuned: it has been tested for direction
  ("extra rations > no rations", "enemy nearby lowers safety") and honesty, not
  for fun.
