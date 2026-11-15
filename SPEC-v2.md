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
5. **Logistics**: articulated trucks with deliveries, garbage trucks with collection routes.
6. **Power grid and night**: plant, substations, power lines, blackout card,
   fire-triggered blackout, utility crew repairs, day/night switch, dark districts
   and unsignalised junctions.
7. **Integration & polish**: incident priorities, crossing-aware routing, vehicle info
   card + follow camera, city pulse, performance pass, README / GIF update.

Each milestone keeps the existing collision / gridlock tests green and adds its own.

## Notes for later milestones

- With one station of each kind, responses in the 10× city take ~2 minutes (median
  drive 108 s, max ~4.5 min across ~1.3 km). Worth considering a second fire / police
  station for big cities.

## Out of scope (for now)

Gradual day/night cycle and weather, multi-lane roads, roundabouts, pedestrians, river and
bridges, scoring / game mode, WebGPU / WebAssembly.
