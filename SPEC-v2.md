# City Emergency Sim v2 — "Living City" Specification

Grow the town into a small city that runs on its own: districts with a purpose, trains,
buses, trucks and garbage trucks that each go somewhere for a reason, and a power grid
whose failures ripple through a district. Still a simulation to watch (no game/score).
Builds on v1 (see SPEC.md); all v1 behaviour stays.

## Scale target: ~10× v1

| | v1 | v2 target |
| --- | --- | --- |
| Road segments | 30 | ~250–300 |
| Buildings | ~250 | ~1300 (fewer but larger: block-sized sites, gardens between houses) |
| Vehicles at once | ~25 | ~400–500 |
| Frame rate | 60 FPS | 60 FPS on Apple Silicon, ≥30 FPS on a laptop with integrated graphics |
| City generation | instant | < 1.5 s |

`?scale=` keeps smaller cities available (and keeps tests fast).

## Technology changes (same stack: TypeScript + Three.js + Vite)

Done up front, because 10× needs them:

- **Spatial grid index** for buildings, vehicles and roads: neighbour queries
  (generation, yielding, curb checks) look at nearby cells instead of everything.
- **A\* with a binary-heap priority queue** and a route cache; replaces the O(n²) Dijkstra.
- **Instanced vehicle rendering** (`InstancedMesh` per model, colour per instance,
  beacons as an instanced overlay) instead of one mesh per vehicle.
- **Shadow tuning**: shadow camera follows the view; distant buildings without shadows.
- **Performance harness**: FPS / sim-step-time overlay (`?debug`) and a headless
  benchmark test that fails if a sim step at 10× gets too slow.

Prepared but only added if the benchmark shows a need:

- Simulation in a **Web Worker**, sending positions as a `Float32Array` snapshot each
  tick (GitHub Pages can't set COOP/COEP headers, so no `SharedArrayBuffer`).

Not planned: WebGPU, WebAssembly, ECS libraries — not needed at this scale.

## City layout

- **Districts (zoning)**, each with its own look and building mix:
  - **Old town / centre**: tenements, shops, mall, town hall.
  - **Residential**: apartment blocks, houses, school, sports facilities.
  - **Commercial**: supermarkets with car parks, petrol station, offices.
  - **Industrial** (1–2 districts): factories with smoking chimneys, warehouses with loading
    ramps, container yards, waste depot / recycling plant.
  - **Utilities**: power plant (cooling tower, chimney), one substation per district,
    power lines from plant to substations.
- **Road hierarchy**: a few longer main streets crossing the city, local streets inside
  districts. Still one lane per direction (multi-lane roads stay out of scope).
- **Railway**: one line across the city, two passenger stations, a freight hub at the edge
  of the map, sidings to industrial districts.

## Landmark buildings (distinct models, not boxes)

Shops with awnings and signs, a shopping mall with a glass atrium and car park, a
supermarket with a car park, a stadium (stands, pitch, floodlights), a sports hall,
a swimming pool, a school with a playground, a hospital (helipad), a town hall (clock
tower), a petrol station (canopy, pumps), two train stations (platforms, canopies),
the power plant, substations, factories, warehouses, the freight hub and a bus depot.

Shops and supermarkets get a **delivery bay / driveway** so trucks unload off the road.

## Railway

- Track with sleepers, crossing streets at **level crossings** (red lights, barriers).
- **Barriers close** for an approaching train, early enough for it to pass at speed;
  vehicles stop in front, **emergency units included**: their route planner prefers a
  detour when a crossing is about to close.
- **Passenger trains**: run end-to-end across the city, stop at both stations
  (dwell time), on a timetable.
- **Freight trains**: shuttle between the freight hub and industrial sidings, which then
  feeds truck deliveries (see logistics).
- Trains never share road space; the crossing logic guarantees no vehicle is on the
  tracks when a train passes (tested).

## Buses

- 2–3 **bus lines** with fixed routes, stops and a timetable; buses start and end at
  the bus depot.
- Stops have a **bus bay** where there is room; otherwise the bus stops in the lane and
  traffic waits behind it or overtakes when the opposite lane is clear.
- Buses yield to emergency vehicles like other traffic.

## Logistics

- **Trucks** (articulated: tractor + trailer):
  - freight hub / factories → warehouses → shops, supermarkets and the mall,
  - most trips stay in industrial districts; deliveries go wherever the customer is,
  - unload at delivery bays (off the road), then return.
- **Garbage trucks**: leave the waste depot on a schedule, follow a collection route
  stopping briefly at buildings (blocking the lane), mostly in industrial districts but
  also elsewhere, and return to the depot / recycling plant to unload.
- Other traffic: private cars as today, plus delivery vans.

## Power grid and blackouts

- The power plant feeds one **substation per district**.
- **Clicking the power plant** opens a card listing the districts with their status;
  each can be switched off (blackout) or back on.
- A **fire at the power plant** has the highest dispatch priority and triggers a
  **blackout in a random district** until the fire is out.
- In a blacked-out district: windows and street lamps go dark and **traffic lights go
  out**; intersections there work as unsignalised ones (already supported by the
  reservation system). Emergency vehicles keep their priority.
- **Repair**: a blackout is ended by a **utility crew** (power-company van) that drives
  from its depot to the district's substation, works there for a while, and restores power.
  The power plant card can also dispatch the crew. For a fire-triggered blackout the crew
  can only start once the fire at the plant is out.

## Day and night

- A simple **day / night switch** (no gradual transition): night darkens the sky and
  ambient light, lights up windows, street lamps, vehicle headlights and beacons.
- Blackouts are most visible at night: the affected district goes dark.

## Emergency services (changes to v1)

- **Incident priority**: power plant > hospital / school / mall > other buildings. A higher
  priority call may take a unit before an older queued call.
- Routing avoids level crossings that are about to close.

## UI

- Click any vehicle: who it is and where it is going ("Truck 12: freight hub →
  14 Market St, furniture"), with an optional follow camera.
- District names shown on the map at high zoom-out levels; blackout districts highlighted.
- A small **"city pulse"** section in the panel: deliveries done, bins emptied, trains on
  time, current blackouts.

## Milestones

1. ✅ **Performance foundation**: spatial index, A\* with heap, instanced vehicles, debug
   overlay, benchmark test. Verified at 10× with today's city generator scaled up
   (400 vehicles: ~0.5 ms per sim step; 30 draw calls; 60 FPS at 2560×1600 on Apple Silicon).
   No Web Worker needed at this scale.
2. ✅ **City generator v2**: bigger map (now the default), nine districts, landmark
   buildings and their models, delivery bays, railway corridor, district labels.
   Main streets are not visually distinct yet. Emergency driving got safer rules found
   by stress tests on the new layout (no passing next to a vehicle at the stop line,
   no overtaking towards an oncoming overtaking unit, yielding vehicles crawl instead
   of stopping, parked vehicles leave room for a fire engine to pass).
3. ✅ **Railway**: double-track passenger line with tunnels at both ends and two stations
   (platforms, canopies, footbridge), separate freight track from the freight hub down a
   branch to the Dockside terminal (push-pull shuttle), 18 level crossings with
   barriers and flashing lights. Safety: crossings close when a train could arrive
   within 18 s; trains only pass a closed crossing with nobody on it; cars never stop on
   the tracks. Small cities (scale 1) have the passenger line but no stations or freight.
   Also fixed: left turns no longer wait forever for a stopped oncoming car.
4. ✅ **Buses**: three lines (W→E along the railway street past both stations, N→S through
   the old town, NW→SE past the hospital and mall to the industrial south-east), each a loop
   with turning loops at the termini; stops ~300 m apart, shared between lines, with a bay
   where the kerb is free and in-lane stops in the old town. Timetable: fleet sized for a
   ~5 min headway (max 4 per line), layover at the home terminus, 3-round-trip shifts.
   Depot with a yard: buses drive out of their stall, through the gate into the depot bay
   and merge into traffic; returning buses park back in a free stall. Small towns have no
   depot (buses stay in service). Cars overtake a bus halted in the lane only with room to
   pull back in and the opposite lane (and its entries) clear; oncoming traffic brakes for
   an overtaker. Buses yield to responders (pulling further right, left edge aligned with
   cars). Click a bus or stop for a card with next stops / departures.
5. ✅ **Logistics**: articulated lorries (tractor + trailer drawn separately, each body on
   the path) load at the freight hub / factories and deliver to warehouses, or from
   warehouses to supermarkets and the mall; delivery vans go from warehouses to shops
   (shop bays are too short for a trailer). Both load and unload at off-road delivery bays
   and drive back; a bay already used by another delivery is not chosen. Fleet: ~20 lorries
   and ~20 vans in the 10× city, 1 lorry and 2 vans in the small town. Garbage trucks (only
   in cities with a waste depot) leave every 5 min, collect from 8 nearby buildings (mostly
   industrial, ordered by driving time) stopping in the lane, then unload at the depot.
   Safety work found by stress tests: long vehicles (> 10 m) need wider gaps between
   junction movements; a long vehicle's tail on the lane it just left is seen by traffic
   there; the leader is the vehicle whose *rear* is closest; vehicles heading for a kerb
   spot held by a bus/lorry wait fully behind it (or park in front when already beside it);
   no in-lane stop approach towards the kerb past parked vehicles. Vehicle info card stays
   in milestone 7.
6. ✅ **Power grid and night**: a substation in every district (no visible power lines —
   user decision), power plant in every city (small towns fall back to any free block).
   Clicking the plant opens a card: per district on/off, "Send crew", crew status.
   Manual cuts stay until switched on or a crew is sent; a fire at the plant cuts a random
   district and a crew goes automatically once the fire is out. Without power a district's
   traffic lights go dark (junctions work unsignalised via reservations) and at night its
   windows, shop fronts, signs and street lamps go dark; a red "NO POWER" district label
   shows at every zoom. Utility crews (1 in small towns, 2 in big cities) park nose-out on
   the driveway of the power-company depot next to the plant, drive out onto the kerb and
   merge, repair at the substation (60–90 s), come back and loop round onto their spot.
   Day/night switch (button, key N): dark sky, moonlight, lit windows (random per
   district), street lamps with pools of light, headlights. Safety work: barriers only
   come down on an empty crossing; delivery bays keep clear of the railway; kerb spots
   start 6 m into a lane; no turning into a lane past a moved-over responder.
7. ✅ **Integration & polish**: incident priorities, crossing-aware routing, vehicle info
   card + follow camera, city pulse, performance pass, README / GIF update.
   Plan agreed with the user (steps 7a–7f):
   - **7a Priorities**: critical (power plant) > high (hospital, school, mall) > normal.
     The queue is served by priority, then age. A higher-priority call may take a unit
     that is *en route* to a lower-priority one (never one on scene); the dropped call
     goes back to the front of its priority in the queue. Priority shown in the panel.
   - **7b Crossing-aware routing**: the rail system predicts when each crossing will be
     closed; emergency units route with an uncached A* that adds the expected wait at
     crossings (also used to pick the fastest unit) and re-plan to a detour when a
     crossing ahead starts closing (only before entering that lane, only if faster).
   - **7c Vehicle card + follow camera**: every road vehicle (civilians too) and trains
     can be clicked; buses keep their card. "Follow" keeps zoom and angle and moves the
     camera target with the vehicle; drag / WASD / Esc stop it. Building hover picking
     uses the spatial grid.
   - **7d City pulse**: deliveries, bins emptied, trains on time (< 30 s late against the
     2½-min timetable), current blackouts, incidents resolved, average response time.
   - **7e Performance pass**: measure first (perf test, `?debug` at scale 10), fix only
     what shows up. Measured (Windows PC, scale 10, ~450 vehicles): sim step median
     0.78 ms, p99 1.3 ms (same as before milestone 7; the train forecast adds ~0.04 ms,
     the crossing-aware unit choice ~2.5 ms once per call); per frame ~0.1 ms for views
     and panel, ~0.4 ms render submit, hover picking 0.17 ms; 144 FPS (display cap) at
     1920×1080, day and night, ~100 draw calls, ~0.7 M triangles. Nothing needed
     fixing; hover picking stays a plain loop. Not measured: integrated graphics.
   - **7f Docs**: README, screenshots, GIF (ffmpeg), SPEC / CLAUDE.md. Also added at the
     user's request: at night, responders' beacons light up the street (halo around the lit
     beacon, pulsing blue pool on the road) and a fixed-size halo, drawn over rooftops and
     without fog, keeps them visible across the whole city.
   A second fire / police station for big cities is left for later.

Each milestone keeps the existing collision / gridlock tests green and adds its own.

## Notes for later milestones

- With one station of each kind, responses in the 10× city take ~2 minutes (median
  drive 108 s, max ~4.5 min across ~1.3 km). Worth considering a second fire / police
  station for big cities.

## Out of scope (for now)

Gradual day/night cycle and weather, multi-lane roads, roundabouts, pedestrians, river and
bridges, scoring / game mode, WebGPU / WebAssembly.
