# City Emergency Sim v3 — Specification (in progress)

v2 "Living City" is done (SPEC-v2.md, all 7 milestones). v3 grows the city's services
feature by feature. Each feature is planned with the user first, then built milestone by
milestone with tests (and the stress test for anything touching traffic or rail).

## Feature 1: Long-distance freight and container cranes — planned, not started

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
  **Status: built (2026-11-17), not committed at the time of writing.** Siding `longhaul`
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
- **F3 Polish.** Click a crane for a card ("Moving container 2 of 4 · next train in 3 min");
  container counts in the city pulse if useful; tests (crane sequence finishes before
  departure, trains never meet on a track or a closed/occupied crossing, containers are
  conserved), stress test, README, screenshot / GIF.

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
