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
| 2 — minds v1 (named villagers) | done, merged to `main` (PR #2) — see below |
| 3a — first gameplay effect: mood sets work speed | done, merged to `main` (PR #2) — see below |
| 1 — 3D look (postprocessing, glTF models) | **not started**: needs `npm install` of new packages and a real browser to judge the result |
| 3b-1 — friendships and rumors | done, merged to `main` (PR #2) — see below |
| 3b-2 — castle will, decrees (reassure / whisper), the gates can open without a keep falling | done on branch `phase-3b2-will` — see below |
| 4 — council of advisors, moral dilemmas, end-of-match Chronicle | **next**; not started |

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

### Phase 3b-1 — friendships and rumors

- Every named villager gets up to two friends or kin at arrival (mutual, nobody
  has more than 3; the pick is a pure function of seed and ids). When someone
  dies, their friends lose a living tie and remember it by name ("Lost their
  friend ..."): a friend is hurt more than a stranger who only saw it happen
  (test: friend -14 vs stranger -10).
- Rumors are things people *say*, not things that are true. Three start from a
  real condition (stores running low, the keep recently attacked, a long stretch
  of full rations); `panic` has no basis at all — it is the seed a rival's
  whisper campaign would plant (`plantRumor`, not yet used by anything in the game).
  They travel along friendships (and to people standing close) one hop per second,
  weaken with every retelling, fade on their own, fade much faster when the
  person's own eyes contradict them, and are dropped the moment the real thing
  reaches that person, so a rumor never double-counts with the need it foretold.
- Honest by construction, again: a rumor enters the same "why" list that makes
  the mood, so `mood == clamp(50 + sum(why))` still holds for everyone, and the
  People panel shows who told them, how many times it was retold, and how much
  they believe it.
- Switch `MIND_FLAGS.social`: with it OFF the simulation is bit-identical to
  Phase 3a (same fingerprints). With it ON (the shipped game) there is a second,
  reviewed baseline, `sim-fingerprints-social.json`. **What the rebaseline
  changed:** in all 6 recorded scenarios only one field differs (the minds hash);
  resources, deaths, unit and building counts are identical. So those scenarios
  do not prove the rumor effect on gameplay; the effect itself is proved by the
  `minds` social checks (mood moves, rumors die out, are dropped once real, save/
  load keeps friendships and rumors and keeps passing them on, 0 multiplayer desyncs).
- **Not done yet (3b-2):** nothing in the game plants rumors, so the enemy does
  not use fear against you yet; no castle-wide morale; no surrender terms; the
  player has no way to spread or quash a rumor. Today the layer is felt only
  through mood (and so work speed, via 3a). Numbers are a first guess, untuned.

### Phase 3b-2 — the castle's will, decrees, and a castle that opens its gates

A second way to win (and lose) that does not need a single wall to fall.

- **Castle will.** `resolve` (0..100) = the average mood of the named people,
  pulled down by the share that are unhappy or desperate (`WILL` in `minds.ts`).
  Under 40 the castle is *wavering*; at 25 or less it is *breaking*. Judged only
  once at least 8 people have names. The People drawer shows it ("Castle will")
  and warns you in the message log at each step.
- **The gates open.** If a castle is *breaking* **and** besieged — at least 3
  enemy soldiers within 16 tiles of its keep **and** more of them than its own
  soldiers there — a visible clock runs. After 60 s the people open the gates:
  the besieger wins ("Hearts and Minds"), no keep destroyed. The clock drains
  twice as fast as it fills, so food, a victory, a decree, or driving the army
  back always buys time. **The same rule binds the AI and you.** Skirmish mode
  only; campaign, Free Build and Survival keep their own win conditions.
- **Two decrees**, for you and the AI alike (same gold price, same cooldown, same
  effect): *Reassure* (40 gold, 60 s) cuts every bad rumor your people hold to 40%
  of its strength and gives everyone a good memory of the lord's word;
  *Whisper* (60 gold, 90 s) plants the false rumor "the keep is doomed" with two
  carriers among the enemy's people. A decree is refused, and costs nothing, if
  you lack the gold, it is cooling down, or there is nobody to reach.
- **A lord who cannot cheat.** The AI decides only from its **own** people's stats
  (`will-test` records every `minds` call it makes and asserts they are all
  `stats(1)`), whispers only while its own army is out, never on Easy, only with
  gold to spare, and not at all in Free Build. It honours the no-rush treaty.
- **Deterministic and multiplayer-safe.** Decrees are recorded in replays, travel
  as validated network intents (`sanitizeReplayEvent` knows `decree`), and take
  effect at the next whole second of the mind update, so every peer computes the
  same state. `test:mp` now sends one decree from each seat through the real
  relay, **before** a client reconnects, and asserts both clients and the server
  end with identical mind state (`67d42857` on all three).
- **Switch `MIND_FLAGS.will`**: OFF is bit-identical to 3b-1. Three recorded
  baselines now exist (`sim-fingerprints.json` = 3a, `-social.json` = 3b-1,
  `-will.json` = 3b-2); `test:perf` checks all three. **What the rebaseline
  changed:** 1 of the 6 recorded scenarios differs (`M-verdant-idle-300s`): the
  AI's gold is 60 lower = exactly one whisper. The other 5 are identical, so those
  scenarios are not evidence that the new layer is balanced — they show only that
  it does not leak into places it should not.
- **Honest by construction, again:** the whisper shows up in the victim's "why"
  list as a rumor, and `mood == clamp(50 + sum(why))` still holds for everyone
  (asserted in `test:will`).
- **Tests added:** `test:will` (decree price/cooldown/reach, what each decree
  really does, determinism and replay, the yield rule incl. no-yield cases such as
  a lone raider, a held gate, a cheerful village, relief, other modes; telegraphing;
  save/load mid-countdown and old saves; garbage in saves; network validation; the
  AI's rules) plus the two relay checks above.

**Not verified / not done (please read):**

- `WillSection.tsx` and the Hud wiring have **not been seen in a browser** (no
  browser or React packages in the authoring environment). `tsc` shows no errors
  in any game-logic file; the UI files show only the usual missing-React-types
  noise. Please look at the Popularity drawer on screen.
- `test:browser` and the full `vite build` were **not** run for the same reason.
- **Balance is a first guess.** Numbers (60 s clock, 3 soldiers, 25/40 thresholds,
  decree prices) were chosen for clarity and fairness, not tuned by playing. In
  particular, whether *you* find it fair to lose by your people opening the gates
  needs real playtests: it is telegraphed (message log + countdown), but a human
  may still feel cheated if they never read the drawer.
- The player cannot yet *see where* a rumor is spreading on the map, and there is
  no "negotiate / surrender terms" screen: yielding is automatic when the rule
  holds. Surrender *terms* as a choice are not built.

### Not verified yet

- `MindSection.tsx` has **not been seen in a browser** (no browser or React type
  packages in the authoring environment); `tsc` shows only the usual
  missing-@types noise for it. Please check it on screen, and run `npm ci && npm test`.
- Balance of the mood numbers is untuned: it has been tested for direction
  ("extra rations > no rations", "enemy nearby lowers safety") and honesty, not
  for fun.
