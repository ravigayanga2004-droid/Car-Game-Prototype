# Project roadmap

This checklist records the imported prototype and remaining work. Completed gameplay features were
already present in the supplied game; the repository import does not represent their original development dates.

## Prototype baseline

- [x] Three.js presentation, garage, chassis, liveries, audio, and staged asset loading.
- [x] Deterministic races with AI, ordered gates, laps, damage, recovery, drifting, and Nitro.
- [x] Six Power Cells per track, three stored charges, and Power Boost activation with HUD feedback.
- [x] Solo, local split-screen, Track Lab, and online ghost client/service implementations.
- [x] Canyon Charge branding and sharing metadata.
- [x] Commit runtime assets, sharing images, dependencies, tests, and design references.
- [x] Fix Windows path handling in bundle checks and ghost-service test startup.
- [x] Validate TypeScript, game tests, production build, bundle budget, and server protocol locally.
- [x] Add main/develop workflow documentation and automated Windows/Linux checks.

## Follow-up work

- [ ] Complete a manual playthrough on Windows, including two-player keyboard and gamepad input.
- [ ] Check touch controls, readability, and frame rate on representative mobile devices.
- [ ] Verify the intended online deployment, allowed origins, and invite links with two clients.
- [ ] Review browser flow and visual-check scripts for fully portable browser discovery and output paths.
- [ ] Review handling and assist defaults after playtesting; log concrete issues before tuning.
- [ ] Prepare a tagged prototype release after playtesting and deployment verification.
