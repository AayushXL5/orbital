# Adding a flight

A flight file lets Orbital draw a launch's path on the globe and tell each city when it will pass
overhead, before any official orbit data exists. Starship test flights are the main use: they
have no TLE until (and unless) they are catalogued.

Create `flights/<id>.json`:

```json
{
  "name": "Starship Flight 15",
  "vehicle": "Starship V3",
  "summary": "One sentence about the mission.",
  "ll2_id": "Launch Library 2 launch id, so the watcher knows when it lifts off",
  "pad": {"name": "Starbase, Orbital Launch Pad 2", "lat": 25.99677, "lon": -97.15799},
  "t0": "2026-11-02T12:15:00Z",
  "window_end": "2026-11-02T13:30:00Z",
  "model": {
    "inclination_deg": 30.5,
    "altitude_km": 275,
    "branch": "descending",
    "seco_s": 491,
    "insertion_s": 1528,
    "deorbit_s": 31938,
    "entry_s": 34132,
    "end_s": 35430,
    "landing": {"lat": -30.65, "lon": -99.44}
  },
  "events": [{"met": 0, "label": "Liftoff", "major": true}],
  "source": {"text": "Where the numbers came from.", "url": "https://..."}
}
```

## What the model fields mean

| Field | Meaning |
| --- | --- |
| `inclination_deg`, `altitude_km` | The target orbit: circular, with J2 drift |
| `branch` | `ascending` if the rocket heads north-east from the pad, `descending` if south-east |
| `seco_s` | Engine cutoff: the end of the powered ascent (seconds after liftoff) |
| `insertion_s` | Circularisation burn, if the ship coasts to apogee first. Omit for a direct ascent |
| `phase_lag_s` | Optional. How far the ship trails a virtual orbit through the pad. Defaults to half of `seco_s`; fit it if you have a reference track |
| `deorbit_s`, `entry_s`, `end_s` | Deorbit burn, atmospheric entry, and the last moment to draw |
| `landing` | Optional. The descent is bent to end here |

## Where to get the numbers

- **Timeline:** the operator's flight timeline (SpaceX publishes one for each Starship flight).
- **Inclination and branch:** the maritime hazard warnings for the launch (NAVAREA IV/XII,
  HYDROPAC). Their zones lie along the ground track; fit an orbit through the pad and the zone
  centrelines. exoplanet5 did exactly this for IFT-14: <https://github.com/exoplanet5/Starship-IFT14>.
- **Landing:** the hazard zone for the planned splashdown or landing.

Check a new file with:

```sh
python -m orbital passes delhi --flight <id> --all
```

After a flight flies, the weekly digest job writes its actual liftoff time into the file
(`t0_actual`), so replays stay right after the launch drops out of Launch Library's upcoming list.
