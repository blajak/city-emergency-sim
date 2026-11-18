# City Emergency Sim v3 — Specification (in progress)

v2 "Living City" is done (SPEC-v2.md, all 7 milestones). v3 grows the city's services
feature by feature. Each feature is planned with the user first, then built milestone by
milestone with tests (and the stress test for anything touching traffic or rail).

## Feature 1: Long-distance freight and container cranes — done (F1–F3)

Agreed with the user on 2026-11-16; to be built in the next session, starting with F1.

### Idea

A long-distance freight train comes into the city from the tunnel at the east end of the
railway (the same tunnel mouth the passenger line uses, next to the Freight Hub), runs into
the hub on its own track next to the existing freight track, and stops under a gantry
crane. The crane swaps containers between the long-distance train and the local freight
shuttle (the existing hub ↔ Dockside train). The shuttle carries containers to the Dockside
Freight Terminal at the edge of the map, where a second crane takes containers off it and
puts others on, and back again. The long-distance train then leaves through the tunnel.

The user showed a screenshot looking east along the line: the tunnel portal at the map edge
with the passenger tracks coming out of it, the hub with its yellow gantry over the tracks
and container stacks, and the Dockside terminal's gantry further south. Today both gantries
and the stacks are static decoration in `render/buildingKinds.ts` (hub/terminal case,
"Gantry crane spanning the yard across the tracks"); they become simulated objects.

### User decisions

1. **Where it comes from:** the east tunnel (next to the hub). It enters the hub beside the
   existing freight track. The hubs (Freight Hub and Dockside terminal) may be rebuilt as
   needed so the track layout, cranes and stacks work well.
2. **The local shuttle stays** and becomes the link to Dockside: containers go
   long-distance train ⇄ shuttle at the hub (crane), shuttle ⇄ Dockside stacks at the
   terminal (second crane).
3. **Frequency and size:** a long-distance train about every 8 minutes, a locomotive and
   4–5 container wagons; each visit swaps 2 containers (2 off, 2 on).
4. **Small towns (`?scale=1`)** have no freight line: unchanged there.

### Plan (milestones)

- **F1 Track and long-distance train.** Extend the freight side of the corridor from the hub
  east to the map edge into the tunnel (a new level crossing on the last street is handled
  by the existing crossing logic). A second track in the hub, parallel to the shuttle's,
  ending under the crane. Long-distance train on a timetable: out of the tunnel, stop under
  the crane, dwell while the crane works, back out through the tunnel (push-pull, locos at
  both ends, like the shuttle). It must not conflict with the shuttle or the passenger
  tracks. The crossing forecast (`RailSystem.closures`), punctuality (city pulse) and the
  vehicle card must cover it.
  **Status: done (2026-11-17), commit e1fdb4d, CI green.** Siding `longhaul`
  (track id 3, `LONGHAUL_OFFSET` 11.25) from the east edge into the hub with its own tunnel
  mouth; train kind `longhaul` every 480 s (first at 60 s), dwell 120 s (placeholder for the
  crane), backs out and disappears in the tunnel; forecast, card and stats cover it. New
  traffic rule found by the logistics test: no junction entry into a lane whose level
  crossing barrier is too close to wait clear of the junction while it is closed or will
  be on arrival (`crossingStopsInJunction`, accelerating ETA).
  **Seed 99 stress regression (DARK=0: 23 reports, was 3 before F1) — investigated and fixed.**
  Not caused by `crossingStopsInJunction` (switching it off gave 30) but by the train itself
  (switching it off gave 2): its closures of the east-street crossing release traffic in
  platoons, and at the junction behind the crossing a lorry turning right sat at its stop
  line on green for > 60 s while a stream of opposing left turns into the same exit lane
  kept the conflicting movement reserved. `oncomingHasPriority` only made a left turn wait
  for an oncoming head that was moving or held a reservation, and the lorry had neither
  *because* the left turns held the movement: each left turn reserved before the previous
  one had cleared. Fix: a stopped oncoming head at its line counts too when only
  reservations of left turns that can go now (`heldByLeftTurns`: holders already in the
  junction or first in their lane; counting any conflict jammed seed 1337, and counting a
  unit queued behind the yielding left turn deadlocked seed 42). The stress runs then showed three more latent problems,
  each fixed: a lorry spawned at a loading bay on top of a utility van coming off its
  driveway (`LogisticsSystem.spotFree` now checks `TrafficSystem.kerbInUse`); a police car
  parked for a call right across the depot driveway gate (the gate is now permanent kerb
  use, and the dispatcher's scene search skips kerb in use); and a civilian that pulled
  over for a fire engine in the last 10 m before the stop line, where nobody passes, so
  each waited for the other (`queuedAtLineAhead`: such a car drives on through the
  junction instead). With the wider hub the cities changed and two more showed up: a bus
  depot placed in a block whose centre is industrial but whose building stood in a
  residential district (large sites now check the district at the building), and a unit
  queued behind a waiting left turn whose reservation made `heldByLeftTurns` deadlock
  (fixed, see above). Tried and dropped: letting a left turn waiting at its line go on
  yellow (it cleared a lorry starved by a steady oncoming stream in seed 42, but shifted
  traffic so a responder in the crossing-routing test reached a crossing just as it
  closed; stress counts move ±10 from such small changes anyway). A lorry turning left can
  still wait through several greens for a gap (seed 42 DARK=0); the queue clears.
  **Bigger hub, 2 locomotives (user decision, same day):** the last column of blocks is
  `HUB_EXTRA_WIDTH` (20 m) wider in freight cities (`FREIGHT_MIN_COLS` = 9 columns), so the
  hub has 88–103 m between the crossing clearance and the buffer (was 68–83) and the train is
  back to **loco + 4 wagons + loco (79 m)**, push-pull, in every tested city.
  **Stress after F1** (12 min, "problems" per big city, scale 10; scale 1 has 0–2 everywhere;
  0 overlaps and 0 trains on occupied crossings in all 20 runs):

  | seed | DARK=0 before fix | DARK=0 after | DARK=2 after |
  |------|-------------------|--------------|--------------|
  | 1337 | –                 | 7            | 1            |
  | 7    | 4–8               | 7            | 3            |
  | 42   | 4–8               | 17 ¹         | 4            |
  | 99   | 23                | 7            | 5            |
  | 5    | 4–8               | 7            | 3            |

  ¹ one lorry turning left waits through several greens for a gap in a steady oncoming
  stream and the queue behind it reaches back towards the hub crossing; it clears (the
  "lorry starvation" family under "Known, open" in CLAUDE.md). Single runs move by ±10.
- **F2 Gantry cranes and containers.** Containers become objects (id, colour) sitting on a
  wagon slot, a stack slot or the crane's spreader. A crane is a small state machine:
  travel along its rails → lower → grab → lift → travel → lower → release → lift. About
  20–30 s per move. Hub: 2 containers from the long-distance train onto the shuttle (or a
  buffer stack when the shuttle is away) and 2 back. Dockside: 2 off the shuttle onto the
  stacks and 2 others on. Trains leave only when their swap is done. Render: low-poly
  gantry (legs on rails, beam, trolley, spreader on cables) and instanced containers.
  Replaces the static decorative gantries and random stacks of the hub and the Dockside
  terminal (`render/buildingKinds.ts`). The long-distance train's fixed 120 s dwell
  (`LONGHAUL_DWELL`) becomes "until the crane is done".
  **Ask the user at the start of F2:** (1) one hub crane spanning both freight tracks
  (siding + shuttle) and the stack row — proposed, simplest; (2) should containers show
  where they come from (e.g. distinct colours for containers arriving from outside) so
  their way to Dockside can be followed?
  **Settled at the start of F2 (2026-11-18):** (1) **one hub crane** spanning the passenger
  side's edge to the stack rows (legs between the passenger and shuttle tracks, and south of
  the stacks), over the shuttle track and the siding; (2) **colour by origin**: containers from
  outside (long-distance train) in cool colours (blues/greens/greys), containers loaded in the
  city in warm colours (reds/oranges/yellows); (3) **20–30 s per crane move**; (4) Dockside's
  incoming containers are **taken away by container lorries**: a lorry stops at a bay on the
  terminal's back street under the crane's cantilever, the crane puts an outside container on
  its chassis, the lorry drives it to a warehouse / factory, swaps it there (off-screen) for a
  city container and brings that back; the crane takes it into the stacks.
  **F2 design:**
  - All containers are 40 ft (12.2 × 2.44 × 2.6 m), one per wagon (the wagon model becomes a
    flat; containers are drawn separately). Long-distance train: 4 wagons, arrives full of
    outside containers, 2 of them (random) are for the city; it leaves full (2 through
    containers + 2 city ones). Shuttle: 2 wagons.
  - `sim/freight/` (new): `ContainerSystem` owns containers and the two yards. A container sits
    on a wagon (train + car), a stack slot (bay, row, tier ≤ 3), a crane's spreader, or a
    lorry. A yard has a crane (gantry travel along the track, trolley across, hoist) working in
    its own straight frame (u along the track, w across, away from the building).
  - Crane moves: lift to safe height → gantry + trolley together → lower → grab (2 s) → lift →
    travel → lower → release. Speeds tuned so a move takes 20–30 s.
  - Hub crane, next move when idle (first that applies): long-distance train's city-bound
    container → shuttle's free wagon if the shuttle is loading here, else the buffer stack;
    city container → long-distance train's free wagon (from the shuttle, else the stack);
    shuttle's city containers → long-distance train's free wagon, else the stack; outside
    containers → shuttle's free wagons (from the stack). Dockside crane: shuttle's outside
    containers → stack; city containers → shuttle; lorry's city container → stack; outside
    container → empty lorry.
  - Trains: a freight / long-distance train leaves when its minimum dwell is over AND the crane
    has nothing more to do for it (and is not holding or lowering onto it). Nothing waits for
    what isn't there: a train leaves with free wagons when the yard has nothing for it.
    The forecast uses an estimate of the remaining crane work for a docked train.
  - Start stock: hub buffer stack 2 city containers; Dockside 6 city containers; the shuttle
    starts at the hub with 2 outside containers.
  - Milestones: **F2a** containers, cranes, trains wait for the crane, render (gantries,
    instanced containers, flat wagons, old decor removed), tests. **F2b** container lorries
    (Dockside bay under the cantilever, chassis trailer, trips to warehouses / factories),
    stress test.
  - **Safety valve (user, 2026-11-18):** with more than `OUTSIDE_BACKLOG_LIMIT` (8) outside
    containers waiting in the stacks, the next long-distance train brings its city-bound
    wagons empty and the hub crane fills them with outside containers (sent back out).
  - **F2a status (2026-11-18): built, not committed.** `sim/freight/containerSystem.ts`
    (`Simulation.containers`, own RNG so traffic randomness is unchanged),
    `RailSystem.departureHold` (minimum dwell 15 s shuttle / 20 s long-distance, then wait
    for the crane; forecast uses the crane's remaining work, `EXPECTED_STAY` for stops not
    reached yet), `render/freightView.ts`, flat `container_wagon`. Measured on seed 1337:
    moves 17–37 s, long-distance stay 90–130 s, shuttle stay 15–105 s. Until F2b, Dockside's
    city stock (6) runs out after ~3 trains; the safety valve then keeps the stacks bounded.
  - **Container length (user, 2026-11-18):** stays 12.2 m on the 11.6 m trailer (0.3 m
    overhang at each end, invisible from the camera; traffic bodies unchanged).
- **F2b plan (agreed direction 2026-11-18, details to confirm before building):**
  - **No container yard in town.** The decorative `container_yard` building (random stacks
    and a fake gantry on the east edge of industrial districts) goes away; its block gets
    ordinary industrial buildings. Dockside is the only place lorries get containers.
  - **Yard road through Dockside (user's idea).** A private two-lane road inside the
    terminal block, parallel to the track on the stack side (≈ 17 m from the track), from a
    T-junction on one street of the block to a T-junction on the opposite one. It is a real
    `RoadEdge` (the street edges are split at the T nodes, before buildings are placed), so
    car-following, queues, junction reservations and level-crossing rules apply as anywhere.
    Only container lorries may use it: `RoadEdge.access = 'yard'`, the router skips yard edges
    unless asked (`allowYard`), and it is used one way only (in at one end, out at the other).
    Nothing else uses yard edges: no civilian spawns or destinations, no addresses, bays,
    frontage, bus lines, lamps or trees; drawn as a concrete yard lane without sidewalks.
    The terminal's plot check ignores its own yard road.
  - **T-junctions:** unsignalised (marked so explicitly: today every node with ≥ 3 edges gets
    lights), first-come reservations like any junction during a blackout.
  - **Two lorry spots under the crane** on the yard lane (trailer centres ~20 m apart, rear
    spot clear of the entry junction, ≥ 25 m from the front spot to the exit line so a
    lorry waiting to leave never blocks a spot). A lorry entering takes the front spot if it
    is free, else the rear one. The crane serves both.
  - **Wider crane:** legs beside the track and beyond the yard road (span ≈ 24 m); stacks
    between the track and the road (more rows if room). Travel range covers both spots.
  - **Two container lorries, always circulating** (no spawning / leaving the map): at a spot
    the crane unloads a returned container (now marked outbound) and loads an outside one;
    the lorry drives to a warehouse, factory, supermarket or mall bay (≥ 18 m), unloads there
    (40–70 s), and brings the same container back (colour unchanged, outbound → it leaves the
    city by shuttle and long-distance train). With nothing to load, a lorry waits at its spot.
    Containers get `outbound` (city stock and returned ones); planners use it instead of
    `origin === 'city'`.
  - **Start stock at Dockside:** 4 outside containers for the lorries + 6 outbound for the
    shuttle. Lorries start at the two spots, empty.
  - **Rendering:** container chassis trailer (skeletal frame, no box), the container drawn
    by `FreightView` on the trailer's pose.
  - **Settled with the user (2026-11-18):** lorries enter from the south street (no level
    crossing there) and wait inside the yard; leaving onto the north street they wait at
    the yard's stop line while the crossing is closed or about to close.
  - **F2b status (2026-11-18): built, not committed.** `world/yardRoad.ts` (`addYardRoad`,
    run after `planRail`, before buildings; `RoadEdge.yard`, `RailPlan.yardRoad`), road
    `YARD_ROAD_OFFSET` = 15 m from the track (the crossing on the north street then lies
    wholly on the street lane beyond the T); lane graph: one centred lane, connectors to /
    from it only for right turns (in from the east on the south street, out eastwards over
    the crossing on the north street); `Router.find(…, yard)`, `Vehicle.yardAccess`;
    wanderers, civilian spawns, `findTimed` (responders), bus planning, frontage, lamps
    and crossings skip it. Spots: rear lorry's tail 3 m into the lane, front spot 4 m ahead
    of it, ≥ 24 m left to the exit line (lanes 64–76 m in 7 tested cities). A lorry at the
    rear spot moves up when the front one is free; the crane serves both, front first, so a
    loaded lorry never waits behind an empty one. `LogisticsSystem` kind `container`
    (statuses `at_yard`, `to_yard`), own RNG, customers: warehouse, factory, supermarket,
    mall bays. Containers have `outbound` (planners use it instead of origin). Render:
    `chassis` vehicle model, containers on lorries in `FreightView`, yard lane with yellow
    edge lines. `container_yard` building removed. Measured (seed 1337, 15 min): a lorry
    round trip ~4–5 min, 0 overlaps on 5 seeds.
  - **Stress after F2b** (12 min, "problems" per city at scale 10; scale 1: 0–2; 0 overlaps
    and 0 trains on occupied crossings in all 20 runs, after fixing the two overlaps the
    first run found, see CLAUDE.md: a pulled-over van moving back out beside a passing police
    car, and a car yielding along the kerb into a bus leaving the depot yard):

    | seed | DARK=0 | DARK=2 |
    |------|--------|--------|
    | 1337 | 7      | 6      |
    | 7    | 5      | 2      |
    | 42   | 3      | 5      |
    | 99   | 3      | 4      |
    | 5    | 3      | 2      |
  - **Risks:** the network change moves every big city's stress counts (chaotic, judge by
    overlaps / jams that don't clear); the T on the street the freight track crosses is
    ~17 m from the level crossing (`crossingStopsInJunction` keeps an exiting lorry in the
    yard while the crossing is closed or about to be); a lorry waiting to turn out across a
    steady stream (the "lorry starvation" family) — no priority rule unless stress shows it.
- **F3 Polish.** Click a crane for a card ("Moving container 2 of 4 · next train in 3 min");
  container counts in the city pulse if useful; tests (crane sequence finishes before
  departure, trains never meet on a track or a closed/occupied crossing, containers are
  conserved), stress test, README, screenshot / GIF.
  **Status: done (2026-11-18), not committed.** Crane card: a gantry crane is a
  `Subject` (`{ kind: 'crane', yard }`) in the vehicle card (what it moves, the trains it
  works for with the work left, lorries at Dockside, stacks, moves; Follow works), picked by
  its legs and girders (not the space under them). City pulse: Containers in (by rail to
  Dockside), Containers out (by long-distance train), Container trips (lorries); null in
  towns without a freight line. `RailSystem.nextLonghaulIn()`. README features / how it
  works / tests updated, `docs/containers.jpg` (headless Chrome, same method as before). No
  new GIF (the existing demo GIF is about the emergency services).

### Settled at the start of F1 (2026-11-17)

- **Hub layout:** the hub block (seed 1337, scale 10) has ~85 m of track between its west
  end and the east street. The long-distance train gets its own siding south of the
  shuttle's track (`LONGHAUL_OFFSET`, 4.5 m further out), from the east tunnel across the
  east street (one level crossing with the passenger tracks) to a buffer in the hub. The
  user chose **4 container wagons** (loco + 4 wagons + loco ≈ 79 m, push-pull) so the train
  fits without standing on the crossing.
- **Train size (revised twice during F1):** a 79 m train (2 locos + 4 wagons) did not fit in
  any tested city (68–83 m between the crossing clearance and the buffer), so for a while it
  ran as 1 loco + 4 wagons (66 m). The user then chose to **make the hub bigger and go back
  to 2 locomotives (one at each end) + 4 wagons (79 m)**: the hub's column of blocks is 20 m
  wider (`HUB_EXTRA_WIDTH` in `roadNetwork.ts`; it moves the east street and widens the whole
  last column). Checked on 12 seeds × scales 4/6/10: 88.7–102.6 m of room, 4 wagons
  everywhere. `RailSystem.planLonghaul` stays as a safety net (fewer wagons, with the
  standing train's tail ≥ 6 m past the crossing, if a city ever has less room).
- **Shuttle away:** a **buffer stack** under the crane; the crane swaps with the stack when
  the shuttle is not there, and the shuttle later takes containers from the stack.
  Neither train waits for the other.
