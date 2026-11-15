# City Emergency Sim — notes for Claude

Browser 3D city simulation (TypeScript + Three.js + Vite, tests with Vitest) with
traffic, traffic lights, an emergency dispatcher (fire + police) and a railway.
Repo: github.com/blajak/city-emergency-sim (public, MIT). Demo on GitHub Pages,
deployed by `.github/workflows/deploy.yml` on every push to `main` (tests + build + deploy).

## Working with the user

- The user writes in **Polish**; answer in Polish. Code, UI, comments, commits and
  docs are in **English**.
- You are the main architect; the user tests and decides. Plan first, then implement
  milestone by milestone. Ask before big design choices.
- The user may also work from a **Windows PC** (and drive sessions from a phone): keep
  everything needed in the repo (this file, SPEC-v2.md, `.claude/launch.json`); after a
  clone run `npm install`. Shell examples here are POSIX; on Windows use PowerShell
  syntax for env vars (`$env:STRESS=1; npx vitest run src/sim/stress.test.ts`).
- Work on `main` (the user chose this). **Commit and push only when the user asks**;
  end commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  After pushing, check CI: `gh run list --limit 1` / `gh run watch <id> --exit-status`.

## Status

- v1 (SPEC.md): all 7 milestones done.
- v2 "Living City" (**SPEC-v2.md** — read it first): milestones 1–6 done
  (performance foundation, city generator v2, railway, buses, logistics, power + night).
- **Next: milestone 7** integration & polish (incident priorities,
  crossing-aware routing for emergency units, vehicle info card + follow camera,
  "city pulse" panel, performance pass, README/GIF update). Details in SPEC-v2.md
  ("Emergency services", "UI", "Milestones"). Not planned with the user yet: start by
  proposing a plan and asking about open choices (as for milestones 4–6). The user
  asked to keep the vehicle info card for milestone 7.
- User decisions so far (details in SPEC-v2.md): 3 bus lines, stops ~300 m, no
  passenger counts; buses leave/enter a depot yard; lorries only to bays ≥ 18 m (shops get
  vans); garbage trucks only in cities with a waste depot; no visible power lines; 1 utility
  crew in small towns, 2 in big cities; manual blackouts stay until switched on or a crew is
  sent; crew vans park on a driveway, never on the road side.

## Architecture (src/)

- `sim/` — pure simulation, no DOM / Three.js, fully testable in Node.
  - `Simulation.ts` fixed 50 ms steps: signals → rail → traffic → dispatcher → buses →
    logistics → power (each system gets the traffic events: parked / halted / departed).
  - `world/` city generator: `roadNetwork.ts` (grid, blocks, rail corridor, `?scale`),
    `districts.ts`, `buildings.ts` (block sites + frontage + delivery bays),
    `rail.ts` (tracks, station/hub/terminal sites), `decor.ts`, `roadIndex.ts`.
  - `traffic/` `laneGraph.ts` (lanes + junction connectors with conflicts),
    `trafficSystem.ts` (IDM car-following, junction reservations, signals, level
    crossings, emergency pre-emption, yielding/overtaking, curb parking/merging),
    `vehicle.ts`, `idm.ts`.
  - `routing/router.ts` A* with heap + per-segment-pair cache.
  - `signals/`, `rail/` (`railSystem.ts` trains + crossing controller, `crossings.ts`),
    `dispatch/` (dispatcher, units, incidents, curb spots).
  - `logistics/logisticsSystem.ts` lorries, delivery vans, garbage trucks (jobs, rounds).
  - `power/powerSystem.ts` districts on/off, dark junctions (`SignalSystem.setDark`), plant
    fires, utility crews with driveway moves (`traffic/offroad.ts`).
  - `testing/overlap.ts` shared collision check for tests (tractor and trailer are separate bodies).
  - `world/transit.ts` plans bus lines/stops (`City.transit`), `world/depotYard.ts` the depot
    stalls; `transit/busSystem.ts` runs buses (timetable, stops, depot yard moves).
- `render/` — Three.js views reading sim state (merged geometry via `GeometryBuilder`,
  instancing for vehicles/trees/sleepers, sign texture atlas in `buildingKinds.ts`).
- `ui/` — dispatcher panel (time, report tools, incidents, units, power, night toggle),
  station card, bus/stop card (`busCard.ts`), power plant card (`powerCard.ts`),
  interaction (picking buildings, buses, stops), toasts, debug overlay.
- Keys: F fire, C crime, N night, Space pause, 1/2 speed, WASD/arrows move.
- URL params: `?scale=1..10` (default 10), `?seed=`, `?cars=`, `?debug`.

## Hard-won rules (don't break them)

Traffic safety took many iterations; stress tests found each of these:
- A vehicle may pass another in the same lane only if `sideBySide` (lateral gap ≥
  half widths + 0.2) — and never inside junctions or next to a vehicle queuing in the
  last 10 m before the stop line (`STOP_ZONE`).
- Parked vehicles use `parkingOffset = 1.5 + width/2` so even a fire engine can pass.
- Yielding vehicles crawl (1.5 m/s) instead of stopping (prevents lock chains);
  fire engines (too wide) don't yield; no two units overtake towards each other.
- Long vehicles: pose from front + rear on the real path (`previousSegment`).
- Level crossings: vehicles stop at the barrier unless clearly past it (`stopS + 0.5`);
  never enter the tracks without room beyond (only vehicles *ahead* count).
- Left turns don't wait for an oncoming car that is stopped without a reservation.
- Buses: a car overtakes a halted bus only with room to pull back in before STOP_ZONE and the
  opposite lane + its entries clear; oncoming vehicles brake for it. A halted bus never leaves
  while overtaken. Vehicles heading for a kerb spot taken by a bus wait behind it in the lane
  (the bus may merge past them). No merging from the kerb next to a long vehicle's tail.
  Yielding long vehicles stay pulled over until their tail leaves the lane.
- Articulated lorry: `pose` is the tractor, `trailer` the trailer (`vehicleBodies()`); collision
  checks must use both. Vehicles > 10 m use `Connector.longConflicts` too. Traffic sees the tail
  of a long vehicle on the lane it just left (`tailsBySegment`); leaders are picked by nearest
  rear. Service vehicles (bus, truck, garbage, delivery) yield (pulled further right) and are
  waited for at kerb spots; others park in front of them when already alongside.
- Night/power rendering: buildings and lamps are merged per district (`setLighting(night,
  powered)` on the city view); `sim.power.version` changes on every power change.
- Level crossings: barriers only come down once the crossing is empty (long lorries).
- Known, accepted: the busy centre junction of seed 7/99 at scale 10 can hold a unit > 60 s
  or cars > 120 s under 300 cars (pre-existing); lorries sometimes wait > 60 s at a stop
  line for ~20 m of room beyond the junction (they always get through).

## How to verify changes

- `npx tsc --noEmit`, `npm test` (≈57 tests, ~1–2 min), `npm run build`.
- For anything touching traffic/rail/vehicles, also run the on-demand stress test
  `src/sim/stress.test.ts` (skipped in `npm test`):
  `STRESS=1 SEEDS=1337,7,42,99,5 SCALES=1,10 MINUTES=12 DARK=0 npx vitest run src/sim/stress.test.ts`
  and again with `DARK=2` (blackouts → unsignalised junctions). Goal: 0 overlaps, 0 trains
  on occupied crossings, no growing jams (a handful of single "still" reports is normal).
  Collision checks in tests use `src/sim/testing/overlap.ts` (tractor and trailer are
  separate bodies). Debug scripts go in temporary `src/zz_*.test.ts` files — delete them.
- Browser: dev server via `.claude/launch.json` ("dev", port 5173). In dev,
  `window.__sim = { city, sim, ctx, frame }` helps to move the camera / step the sim. When
  the browser pane is hidden the render loop pauses: step with `sim.step()`, move the
  camera from JS, call `frame(0)` to draw, then take a screenshot.
