# @habemus-papadum/aiui-intent-runtime

The intent client's host-agnostic **capture + transport runtime**: everything a browser host
needs to sense a page and stream captured intent to the aiui channel, with the hard logic kept
DOM-free (host-agnostic cores + injected browser edges) so it tests in plain Node and serves
multiple hosts — today the intent client's CDP tier and its MV3 side panel.

Lineage: this is the live runtime of the retired `aiui-dev-overlay` (its "B2.4 / C1"
extraction), copied out in the overlay retirement
(`docs/proposals/dev-overlay-retirement.md`). The original is deleted; read it in git history.

## Entries

| Subpath | Job |
| ------- | --- |
| `.` | the shared substrate: the error-toast model, the `window.__AIUI__` page instrumentation, the binary `/ws` protocol client, the intent-thread contract |
| `./locator` | `locateComponents` — screenshot-rect → components → source, via the source-processor's `data-source-loc`/`data-cell` stamps |
| `./talk` | the audio stack: `createTalk` lanes (REST segments + realtime PCM), `WorkletPcmSource`, `SpeechPlayer` (TTS with barge-in), the mock transcriber |
| `./video` | `VideoSampler` — the screen-share frame sampler (smart gate / continuous cadence) |
| `./selection` | `installSelectionWatcher` — "select text/equation, then ask about it" |
| `./wire` | `createWire` — the per-thread socket: batched event log, shot/audio uploads, lowered echoes merged back into the engine stream |
| `./thread` | `openIntentThread` — the host-agnostic thread adapter (id + send/finish/chunk/attachment/audio/video verbs) |

## Install

```sh
npm install @habemus-papadum/aiui-intent-runtime
```

## The discipline

Every module splits into a framework-free core and a thin browser edge injected as a dependency
(`PcmSource`, `VideoSamplerDeps.captureFrame`, `WireDeps`). The cores run under Vitest in plain
Node with fake edges; the real edges exist only in a live tab (`getDisplayMedia`, `AudioWorklet`,
`chrome.tabCapture` have no jsdom equivalents). Keep that split when extending — it is what makes
the runtime reusable across hosts and testable at all.
