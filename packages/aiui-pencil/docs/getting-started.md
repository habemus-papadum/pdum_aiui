# Getting started

The [package README](../README.md) describes the current API, input policies,
programmatic strokes, and lifecycle. The package is now a local drawing toolkit;
it has no server, relay, pairing, remote application, or transport configuration.

Run `pnpm -C demos/circle dev` for the gallery's drawing example. Run
`pnpm -C packages/aiui-pencil lab` for the tuning rig. It listens on all network
interfaces and asks which IPv4 interface shares your iPad's network. Copy the
printed iPad URL and paste it into Safari using Universal Clipboard. To skip the
picker, run `LAB_INTERFACE=en0 pnpm -C packages/aiui-pencil lab` (substitute your
interface name or IPv4 address). The Mac and iPad should be on the same network.

The applications demonstrate different uses of one instrument:

- Circle retains frozen samples for scoring after the rendered ink fades.
- The lab retains stroke data and replays it under changed brush parameters.
- Both consume `PencilSurface`; its pointer binding now includes the former
  client's pencil priority and palm rules.

The [architecture review](./architecture-review.md) records the feature inventory,
current structure, extraction decisions, and proposed next changes. Those proposals
are review material, not a commitment to retain the current classes or API shape.
