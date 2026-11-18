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
- v2 "Living City" (**SPEC-v2.md** — read it first): all 7 milestones done
  (performance foundation, city generator v2, railway, buses, logistics, power + night,
  integration & polish).
- **v3 (SPEC-v3.md), in progress feature by feature.** Feature 1 "Long-distance freight
  and container cranes" is **done and deployed** (CI green):
  - F1 (commit e1fdb4d): siding from the east tunnel into the hub, long-distance train
    (loco + 4 wagons + loco, 79 m; the hub column is 20 m wider), plus the seed 99 stress
    fix (left-turn starvation of a right-turning lorry) and three latent kerb/yield bugs.
  - F2 + F3 (commit 37a0bd0): containers and gantry cranes at the hub and Dockside, trains
    wait for the crane; private yard road through Dockside with two container lorries
    (`container_yard` building removed); two traffic fixes from the stress test; crane
    card, container counts in the city pulse, README + docs/containers.jpg.
  Details and every user decision are in SPEC-v3.md.
  **Feature 2 "Match day at the stadium"** (plan 93ad13a): M1–M3 in commit 74ee344
  (stadium on the island of a one-way loop car park, one gate, duty spaces for the police car
  and the ambulance; ambulance unit at the hospital; `sim/events/matchSystem.ts`: fans arrive
  over 3 min, 2 min match, everyone leaves at the whistle). **M4 done and deployed (commit 1dee976, CI green):** stadium
  card (`ui/stadiumCard.ts`, "Organise a match"), match toasts, `MATCH=1` in the stress test,
  README + docs/match.jpg, and three fixes the match stress found (see the rules below).
  Details and every user decision in SPEC-v3.md.
- Other ideas discussed with the user for v3 (not chosen yet): ambulances for medical calls
  (the ambulance unit comes with Feature 2), traffic accidents with a tow truck, roadworks,
  a port with a container ship at Dockside, a "city runs by itself" mode with random calls, a second fire /
  police station for big cities, spreading fires, weather, gradual day/night,
  pedestrians; and the lorry starvation case under "Known, open".
- Milestone 7 (steps 7a–7f in SPEC-v2.md): **7a** incident priorities (+ diverting an
  en-route unit to a more urgent call), **7b** crossing-aware routing (train forecast in
  `RailSystem.closures`, `Router.findTimed`, responders re-plan around closing crossings).
  **7c** vehicle card (`ui/vehicleInfo.ts`, `ui/vehicleCard.ts`) + follow camera
  (`SceneContext.follow`). **7d** city pulse (`Simulation.pulse()`, passenger
  timetable + punctuality in `RailSystem`, logistics totals; panel section).
  **7e** performance measured, nothing to fix (numbers in SPEC-v2.md).
  **7f** README, `docs/` media (demo.gif, screenshot.jpg, night.jpg) and night beacon glow
  (`VehiclesView`: halos as `THREE.Points`, road pools).
- README media were captured with headless Chrome driven over the DevTools protocol from a
  throwaway Node script (`window.__sim` in dev to step the sim and aim the camera,
  `Page.captureScreenshot` per frame), then `ffmpeg` → GIF (576 px, 6 fps, 96 colours,
  ~4 MB). ffmpeg is installed via winget on the Windows PC.
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
  - `logistics/logisticsSystem.ts` lorries, delivery vans, garbage trucks (jobs, rounds),
    container lorries (Dockside yard ⇄ warehouses / factories / big shops).
  - `freight/containerSystem.ts` containers (origin colour, `outbound`), the hub and Dockside
    yards (stacks, one gantry crane each, own frame u/w), lorry spots; gates train departures
    (`RailSystem.departureHold`). `world/yardRoad.ts` the private yard road (`RoadEdge.yard`).
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
  fire engines (too wide) don't yield; no two units overtake towards each other
  (`oncomingOvertaker`: a unit already moving over counts anywhere ahead on the stretch, not
  only within `ONCOMING_RANGE` — two fire engines starting from both ends of a 68 m street
  met in the middle; if both just started, the lower id goes on).
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
- Crossings close when the forecast (`RailSystem.closures`, station stops included) says a
  train is within CLOSE_ETA; barriers and responder routing use the same forecast, so keep
  them one function. The freight shuttle starts at the hub with the terminal ahead and
  only reverses after reaching an end (no stops left).
- Pulling over needs a free kerb beside the vehicle and 12 m ahead (`PULL_OVER_ROOM_AHEAD`),
  including kerb used by driveway manoeuvres (`TrafficSystem.addKerbUsers`; buses pulling out of the depot yard too): a vehicle that
  pulls over and stops behind a parked one blocks the responder behind it (deadlock with a
  lorry's tail in the junction). The "beside a responder keeps yielding" rule only holds
  a vehicle with a blocked kerb ahead when the responder is really side by side.
- No junction entry into a lane whose level-crossing barrier is too close to wait clear
  of the junction (`crossingStopsInJunction`) while the crossing is closed or forecast to
  be closed on arrival: a lorry stopping there left its trailer across other movements.
  The arrival time uses real acceleration; a crawl estimate starved lorries for minutes.
  Also when the crossing is open but the queue beyond the tracks leaves no room for the
  whole vehicle — only if its tail would really be in the junction (`stopS - 0.3 - length
  < 1`): a lorry waiting there locked two dark junctions (seed 42), while checking it for
  every near barrier starved lorries at a busy crossing with a short lane beyond.
- The long-distance freight train only runs with as many wagons as fit clear of the street
  crossing (`RailSystem.planLonghaul`); a standing train on a crossing kept it closed for
  minutes and jammed the street. The hub column is `HUB_EXTRA_WIDTH` wider so 4 wagons + 2
  locos always fit (`longhaul.test.ts` checks several seeds).
- Left turns yield to an oncoming head that is moving, holds a reservation, or stands at
  its line kept out only by left-turn reservations (`heldByLeftTurns`): otherwise a stream
  of left turns into the same exit, each reserving before the last cleared, starved a
  right-turning lorry for minutes. Don't widen it to any conflict (that jammed seed 1337),
  and only count holders that can go now (in the junction or first in their lane): a unit
  queued behind the waiting left turn deadlocked seed 42.
- Stress counts are chaotic: any traffic-rule or city-layout change moves single seeds by
  ±10 "still" reports. Judge a fix by overlaps / jams that don't clear / the whole matrix,
  and trace the head of a reported queue before changing rules. Tried and dropped: left
  turns going on yellow (broke the crossing-routing test by shifting traffic).
- Scene spots: the dispatcher searches the kerb metre by metre for a spot clear of other
  scenes AND of vehicles standing there (a unit that just finished and waits to pull out)
  AND of kerb in use by driveway manoeuvres (`TrafficSystem.kerbInUse`; the utility depot's
  gate is permanent kerb use). Lorries/vans/garbage trucks spawn at bays only where
  `kerbInUse` is false too (one spawned onto a van coming off its driveway).
- A car ahead of a responder in the last `STOP_ZONE` metres before the line does not pull
  over (`queuedAtLineAhead`): nobody passes there, so both waited for each other forever.
  Only in the lane-scan loop; the "beside a responder keeps yielding" loop must keep it
  (dropping it there made cars move back into the passing responder).
- Dockside yard road: only vehicles with `yardAccess` may route over it (`Router.find(…,
  yard)`); everything that picks lanes or edges (spawns, wandering, frontage, lamps,
  crossings, bus planning, responders' `findTimed`) must skip it. Right turn in / right turn
  out only: the street lane between a yard T and the corner junction is ~11 m, too short for
  a lorry to wait on. The road is `YARD_ROAD_OFFSET` from the track so the level crossing on
  the exit street lies on the lane beyond the T (crossings inside a junction are not seen).
- A pulled-over vehicle keeps yielding while a passing responder's body is level with its own
  along its heading (`overlapsAlong`, `PASSING_LEAD` ahead when the responder is moving):
  the centre-distance test `alongside(-0.5)` let a van with a blocked kerb ahead move back
  out into a police car passing its tail (seed 1337, F2b).
- A bus pulling out of the depot yard is kerb use (`addKerbUsers`), and a vehicle driving
  along the kerb towards the gate holds it (`KERB_APPROACH`): a car yielding to a responder
  drove along the kerb into a bus coming out (seed 7, F2b).
- Stadium car park (`world/carPark.ts`): the stadium stands on the island inside the loop
  (`stadiumIsland`, one block for both); one gate, a two-way access road, a one-way loop
  (two `oneWay` edges, so nobody circles). The two spaces before the exit belong to the duty
  units (`MatchSystem.dutySpaces`); `Router.findTimed` lets a unit starting there drive out. Routes may use it only when they start or end there
  (`Router.find`), wanderers never turn in, responders never route through it. Out of it right
  turns only. The access road must hold a queuing car's whole body: a short one let a tail hang
  back over the gate turn onto the loop, where the car behind couldn't see it.
- Long vehicles (> 10 m) route round lanes shorter than `SHORT_LANE` (17 m) when they can
  (`Router.find(…, long)`): two lorries on the 13 m street lane between a yard T and the corner
  each stopped with the tail in the other's junction (gridlock for minutes).
- Trains at a yard leave only when the crane has nothing more for them (`departureHold`);
  `docked()` must not depend on `dwell > 0` (it is decremented before the hold is asked).
- Exit room: a vehicle reserves a junction only if the exit lane has room for it after the
  vehicles still crossing into that lane (`exitRoom`: holders of reservations for connectors
  into it). Measuring only the cars already on the lane let a car follow another through the
  car park gate and stop with its tail across the gate (seed 7, DARK=2, match).
- A vehicle that waiting at the stop line would still have its tail on a level crossing
  (`tailOnTracksAtLine`: short lane between tracks and line, long vehicles) crosses an open
  crossing only holding its junction reservation, asks for it from the barrier
  (`requestDistanceOn`) and gives it back when the barrier starts to close. A lorry stopped at
  the line with its trailer on the crossing kept the barriers up (they need an empty crossing)
  while the queue at the other barrier blocked its movement (seed 1337, three trains stopped).
- A vehicle sent elsewhere while `arriving` and still in the lane (lateral ≤ 0.5) drives on
  instead of becoming `waiting_to_merge` in mid-lane (a diverted fire engine still moved over
  to pass: the car beside it stopped yielding and moved into it).
- Responders' crossing-aware routing counts a closure starting within 3 s + 15 % of the ETA
  after the free-flow arrival estimate (`ETA_SLACK`): real arrival is later, and a unit
  planned to pass just before the barriers came down. Barriers still use `closures` as is.
- Utility depot driveway: one van manoeuvres at a time (`drivewayFree`; a returning van waits
  at the entry kerb), and none starts pulling out while another is at the gate or returning
  within 120 m (its way out crosses that kerb spot).
- Match day: after the whistle fans pull out in the order of their spaces from the exit, each
  only once everyone parked nearer the exit has pulled out (`nobodyPullingOutAhead`): with a
  random order a car waiting to merge watched the whole queue pass it (260 s, seed 5).
- Known, accepted: the busy centre junction of seed 7/99 at scale 10 can hold a unit > 60 s
  or cars > 120 s under 300 cars (pre-existing); lorries sometimes wait > 60 s at a stop
  line for ~20 m of room beyond the junction (they always get through).
- `crossingRouting.test.ts` sums four sets of calls and asks for a third less time at closed
  barriers with the forecast (51 s vs 99 s after the ETA slack, F2 M4): the gain varies a lot
  with where the trains happen to be. Known, open: seed 42 at scale 10 shows more single
  > 60 s waits at dark junctions since the stadium moved (13–18).
- Known, open (found in 7b, seed 7 scale 10 DARK=2): a lorry at the stop line can be
  starved by a stream of lorries on a long-conflicting movement (each reserves from
  further away), and a responder queued behind it waits too. Possible fix: give a vehicle
  that has waited at the line long enough priority for `longConflicts`.

## How to verify changes

- `npx tsc --noEmit`, `npm test` (≈86 tests, ~2 min), `npm run build`.
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
