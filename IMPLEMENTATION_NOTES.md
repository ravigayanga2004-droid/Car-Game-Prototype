# Canyon Charge implementation notes

Historical notes from the supplied game export. Linux paths, runtime identifiers, and approval notes
below describe the original production environment. Use the README and setup guide for this repository.

- Supplied source/assets archive: https://d1oupeiobkpcny.cloudfront.net/assets/dashboard/materials/2026/09/30/d3ec5987d1d0e9ac992c349ef371b844b8876d8752fd60ba2556f3f94135748a.zip
- Downloaded archive: `incoming/canyon-circuit.zip`
- Archive SHA-256: `d3ec5987d1d0e9ac992c349ef371b844b8876d8752fd60ba2556f3f94135748a`
- Active project: `/home/ubuntu/canyoncharge`, Three.js/Vite runtime, configured PORT=3000 and HOST=0.0.0.0.
- Active asset runtime: `/home/ubuntu/.manus-addons/manus-webdev-sha-48128aa19f3fef08/runtime/game-dev`; capabilities include `threejs`, manifestVersion 2.
- Approved Blueprint: Canyon Charge remix, English, hybrid asset production, no online integrations.
- Integration approach: use the supplied Canyon Circuit source/assets/config as the game layer while preserving the initialized project identity and runtime files. Add six deterministic, track-placed Power Cells: cells bank a separate up-to-three-charge Power resource mid-race, the HUD labels it POWER, and the existing boost control spends a stored charge before falling back to the supplied Nitro meter.
