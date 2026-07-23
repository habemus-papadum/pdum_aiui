# demo: gratings

How gratings steer and split light: phase arrows, interference, the grating equation, a spectrometer designer, and the zone-plate lens — diffraction as a design tool.

An in-repo demo wired to the workspace (`workspace:^`, no npm install of aiui packages, no build
step). Run the loop from this directory:

```sh
pnpm claude   # terminal 1 — Claude Code with the aiui channel + session browser
pnpm dev      # terminal 2 — this app (Vite + the intent tool)
```

Then open it in the session browser — the window you share with the agent:

```sh
./aiui open http://localhost:5173   # from the repo root
```

Activate the intent client (**⌘B**) and describe
what you want. See [docs/guide/getting-started.md](../../docs/guide/getting-started.md).
