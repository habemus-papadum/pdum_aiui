# Audio demo

Follow the repository's AGENTS.md and aiui architecture. Keep durable audio/session state in
`src/model/store.ts`, cells and agent actions in `src/model/graph.ts`, and disposable UI in `src/ui`.
Use the host AudioProvider so the demo and VoiceDock share one microphone. Do not embed keys or
log credential-bearing URLs. Version fields are managed by CI.
