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

### Open questions for the next session

- Exact hub track layout (where the second track and the crane rails fit in the hub block,
  and whether the hub block needs to grow); check visually before building.
- What happens when the shuttle is not at the hub when the long-distance train arrives:
  proposal is a small buffer stack under the crane, so neither train waits for the other.
