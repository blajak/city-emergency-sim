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
- Work on `main` (the user chose this). **Commit and push only when the user asks**;
  end commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  After pushing, check CI: `gh run list --limit 1` / `gh run watch <id> --exit-status`.

## Status

- v1 (SPEC.md): all 7 milestones done.
- v2 "Living City" (**SPEC-v2.md** — read it first): milestones 1–6 done
  (performance foundation, city generator v2, railway, buses, logistics, power + night).
- **Next: milestone 7** integration & polish (incident priorities,
  crossing-aware routing for emergency units, vehicle info card + follow camera,
  "city pulse" panel, README/GIF update). Details and user decisions are in SPEC-v2.md.

## Architecture (src/)

- `sim/` — pure simulation, no DOM / Three.js, fully testable in Node.
  - `Simulation.ts` fixed 50 ms steps: signals → rail → traffic → dispatcher.
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
- `ui/` — dispatcher panel, station card, interaction (picking), toasts, debug overlay.
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
- Known (pre-existing, not bus-related): the busy centre junction of seed 7/99 at scale 10 can
  hold a unit > 60 s or cars > 120 s under 300 cars.

## How to verify changes

- `npx tsc --noEmit`, `npm test` (≈50 tests, ~45 s), `npm run build`.
- For anything touching traffic/rail, also run a temporary stress test (several seeds,
  scale 1 and 10, 10 sim-minutes, incidents every 10–20 s) checking vehicle overlaps
  (use `SpatialGrid` + `obbOverlap` as in `src/sim/perf.test.ts`), train-on-occupied-
  crossing, and units standing still > 60 s. Delete temporary `src/zz_*.test.ts` files.
- Browser: dev server via `.claude/launch.json` ("dev", port 5173). In dev,
  `window.__sim = { city, sim, ctx }` helps to move the camera / step the sim. When the
  browser pane is hidden the render loop pauses: step with `sim.step()` and move the
  camera from JS, then take a screenshot.
