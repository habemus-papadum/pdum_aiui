# @habemus-papadum/aiui-oracle

A realtime voice control surface for aiui apps: a component that opens a WebRTC session
directly from the browser to OpenAI's Realtime API and presents the app's own cells and
actions to the model as **tools**. The user talks; the oracle answers *and drives the app*,
through the same validated setters the widgets use.

One session, one tool surface, one conversation. It tracks no navigation and no page content
and is an app feature, like the pencil — in-repo it is mounted by the voice dock
(`@habemus-papadum/aiui-dock`), and any aiui page can mount it directly.

## Install

```sh
npm install @habemus-papadum/aiui-oracle
```

## Read next

- [The Oracle](./docs/oracle.md) — developer setup (the Vite plugin's `devKeys`, the key
  chain, the mint endpoint), the session engine and its ledger, the prompt slots, the tool
  projection, and the status of the parked seams.
- [Getting started](./docs/getting-started.md).
