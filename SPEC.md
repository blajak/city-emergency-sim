# City Emergency Sim — MVP Specification

A small browser-based 3D city simulation with traffic, traffic lights and an
emergency dispatch system (fire brigade + police). Casual project, polished for
a GitHub portfolio.

## Tech stack

- **Vite + TypeScript**
- **Three.js** for rendering (no game engine)
- **Plain HTML/CSS** overlay for the dispatcher panel (no UI framework)
- **Vitest** for simulation logic tests
- **GitHub Pages** for the live demo
- Code, UI, commits and docs in **English**
- All 3D assets generated procedurally in code (no external models)

## Architecture

The simulation knows nothing about rendering.

```
src/
  sim/              pure logic, testable without a browser
    world/          road graph (nodes = intersections, edges = segments), buildings
    traffic/        vehicles, car-following (simplified IDM), light handling
    signals/        traffic light controllers (phases, timings)
    routing/        A* over the road graph
    incidents/      fires and crimes + lifecycle
    dispatch/       dispatcher, units, incident queue
    Simulation.ts   fixed timestep (~20 ticks/s), pause, time scale
  render/           Three.js; reads sim state and draws it (interpolated)
  ui/               dispatcher panel, incident tools, time controls
```

## City

- Regular grid with a few irregular (curved/diagonal) streets, ~20–30 road segments.
- Only signalised intersections (no roundabouts).
- Right-hand traffic, one lane per direction.
- Always daytime.
- Camera: orbit (rotate) + zoom only.

### Visual detail — "Level B" stylised low-poly diorama

- **Buildings:** box mass, sometimes with a cornice or set-back top floor.
- **Windows:** generated texture with window rows; floor count follows height.
- **Ground floor:** band in a different colour (shops/gates feel).
- **Roofs:** mostly flat with small details (AC unit, roof access, chimney);
  some tenement houses get gabled roofs for a European look.
- **Palette:** pastel tenement facades + a few grey office blocks.
- **Fire Station:** red, large garage doors, tower.
- **Police Station:** blue/white, sign/emblem.
- **Streetscape:** sidewalks, kerbs, lane markings, zebra crossings,
  street lamps, low-poly trees.
- **Vehicles:** civilian (sedan, hatchback, van, several colours),
  fire engine (long, red, ladder), police car (white/blue, light bar).
- **Performance:** ~100–150 buildings, merged geometry / instancing.

## Civilian traffic

- ~20 cars driving random routes indefinitely (pick a new destination on arrival).
- Keep safe distance, brake smoothly, obey traffic lights.
- No vehicle ever passes through another vehicle.

## Units

- Start: **1 fire engine** (Fire Station), **1 police car** (Police Station).
- Clicking a station opens a menu to **add / remove units**, 1–3 per station.
- Only units idle at the station can be removed.
- **Fire engine:** after an incident, returns to the Fire Station.
- **Police:**
  - Car mode: `patrol` or `responding`.
  - At least one police car should always be patrolling.
  - When the patrolling car is dispatched, a free car at the station
    immediately leaves to take over patrol.
  - If no car is free at the station, the first car to finish an incident
    takes over patrol; otherwise finished cars return to the station.

### Unit statuses

`at_station` · `patrolling` · `en_route` · `on_scene` · `returning`

## Incidents

- Toolbar modes: **Simulate fire**, **Simulate crime** → click a building.
- One active incident per building; stations cannot be incident targets.
- Visual marker: fire + smoke for fires, blinking icon above the roof for crimes.
  No permanent damage after a fire.
- Lifecycle: `reported → queued | assigned → en_route → on_scene → resolved`.
- On-scene duration is random (initial ranges: fire 20–40 s, crime 10–25 s of sim time; tunable).
- Fires do not spread (MVP).
- Events are triggered only by the user's click (no random spawning in MVP).

## Dispatcher

- Assigns the available unit of the right type with the **shortest travel time**
  (patrolling police cars included).
- If no unit is available, the incident waits in a **FIFO queue**.
- A unit that becomes free takes the oldest queued incident of its type.

## Emergency driving

- Flashing lights (visual only, no sound).
- At a red light: slow down before the intersection, then proceed through.
- Civilian cars ahead pull towards the right edge of the lane and slow down.
- Civilian cars approaching an intersection the emergency vehicle is about to
  enter must brake, even on green.
- **Safety rule:** no overlapping vehicles. If a car cannot yield
  (e.g. it is inside the intersection), the emergency vehicle slows / waits
  and the car clears the intersection first.

## Dispatcher panel

- Incident list: type, building, status, assigned unit, elapsed time.
- Unit list: type, status.
- Pending queue.
- Time controls: **Pause**, **×1**, **×2**.

## Milestones

All seven milestones are done.

1. ✅ City layout, buildings, camera
2. ✅ Civilian traffic
3. ✅ Traffic lights
4. ✅ Dispatcher + fires (fire brigade)
5. ✅ Police: patrol logic, crimes, add/remove units
6. ✅ Emergency driving + yielding
7. ✅ Polish: README with GIF, tests, GitHub Pages deploy

### Decisions made during implementation

- Returning units count as available and can be re-assigned on the way back.
- Units park at the curb (partly on the sidewalk) so traffic can pass them.
- Cars at the stop line don't pull over when the responding unit turns right there;
  the unit waits behind them instead (pulling over would block its turn).
- Cars with a parked vehicle beside them at the curb keep driving instead of stopping.
- Extra controls: keyboard shortcuts (F, C, Space, 1, 2, Esc) and `?seed` / `?cars` URL
  parameters.

## Out of scope (for now)

Roundabouts, multi-lane roads, day/night cycle, pedestrians, fire spreading,
random incident spawning, sirens, police chases, vehicle-follow camera.
