# Canyon Charge: VS Code setup

The repository is already initialized and connected to GitHub. Clone it to start on another computer:

```bash
git clone https://github.com/ravigayanga2004-droid/Car-Game-Prototype.git
cd Car-Game-Prototype
git switch develop
```

Open the folder in VS Code. Install Node.js 22.12 or newer and pnpm 10.18.0:

```bash
npm install --global pnpm@10.18.0
pnpm install --frozen-lockfile
pnpm install --dir server --frozen-lockfile
pnpm dev
```

Open http://127.0.0.1:3000. On Windows, if PowerShell blocks the package manager's `.ps1` launcher,
use `npm.cmd` and `pnpm.cmd` in place of `npm` and `pnpm` in these commands.

Before opening a pull request:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:server
```

The build generates `server/lib/sim.mjs` from the same simulation used by the client. Run the build
before server tests on a new checkout. Build output and installed dependencies are ignored by Git.

For browser smoke checks, keep the dev server running and run `pnpm smoke` in another terminal.
The existing browser scripts default to `/usr/bin/chromium`; set `CHROME` to an installed Chrome or
Chromium executable on other systems. For example, in PowerShell:

```powershell
$env:CHROME = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
pnpm smoke
```

Use `develop` for integration and create a branch for each task:

```bash
git switch develop
git pull --ff-only
git switch -c feature/your-feature
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for commits, pull requests, and validation.

## Assets and controls

`public/assets/` contains the optimized runtime models, textures, audio, and effects.
`assets/share/` contains the two sharing images used during builds. Large raw/catalog sources stay
ignored; regenerating assets is optional and requires the original production tools and inputs.

P1 controls: W/S accelerate and brake, A/D steer, Space drift or trick, Shift spend stored Power or
use Nitro, E use an item, R reset, and Esc pause. See the README for P2, gamepad, and touch controls.
