# Encoding attachment paths in Claude Code channel notifications

*Custom Channels · research preview (Claude Code v2.1.80+). The `--channels` flag
syntax and the notification contract may change before GA.*

## The one fact everything follows from

A channel pushes an event with a single notification method:

```ts
server.notification({
  method: "notifications/claude/channel",
  params: {
    content: "…",          // string → becomes the <channel> tag BODY
    meta:    { /* … */ },   // Record<string,string> → each key becomes an ATTRIBUTE
  },
});
```

Claude receives it rendered as one tag:

```xml
<channel source="fakechat" key1="val1" key2="val2">
BODY (this is `content`)
</channel>
```

Two consequences that drive the whole design:

1. **The payload is text, not pixels.** Whichever field you use, you are handing
   Claude a *filesystem path* (or an id), never the image bytes. Claude then calls
   its Read/View tool on that path to actually pull the image into context. The
   channel runs locally as a subprocess, so a bare absolute path is enough — no
   upload, no base64. (This is precisely what fakechat does: inbound files land in
   `~/.claude/channels/fakechat/inbox/` and the path is included in the notification.)
2. **`meta` attributes are visible in the same tag as the body.** So "referring to a
   meta field from the content" is natural — the attribute value is sitting right
   there next to the prose. That's the basis of the hybrid option below, which is the
   real answer to "can I keep positional clarity *and* use meta?".

Constraint to remember: **meta keys must be identifiers** — letters, digits,
underscores, no hyphens. Values are strings.

---

## Option A — path inline in `content`

Drop the absolute path into the body exactly where the image belongs.

```ts
server.notification({
  method: "notifications/claude/channel",
  params: {
    content:
      "Here's the crash on the settings screen: " +
      "/Users/nehal/.claude/channels/fakechat/inbox/img-a1b2.png\n" +
      "What's causing the blank panel?",
  },
});
```

Renders as:

```xml
<channel source="fakechat">
Here's the crash on the settings screen: /Users/nehal/.claude/channels/fakechat/inbox/img-a1b2.png
What's causing the blank panel?
</channel>
```

- **+** Position is unambiguous — the path sits at its reference point, so multi-image
  messages ("compare *this* to *this*") stay ordered correctly with zero extra
  machinery.
- **+** Simplest possible server; nothing to map.
- **−** Long ugly paths clutter the prose; the more images, the noisier the body gets.
- **−** The reference is untyped — Claude infers "image" from the extension/context.
  Fine in practice, but you can't attach `mime`/`size`/`caption` cleanly alongside.

## Option B — path in `meta`

Keep the body clean; put the path in an attribute.

```ts
server.notification({
  method: "notifications/claude/channel",
  params: {
    content: "What's causing the blank panel on this screen?",
    meta: {
      image_path: "/Users/nehal/.claude/channels/fakechat/inbox/img-a1b2.png",
      image_mime: "image/png",
    },
  },
});
```

Renders as:

```xml
<channel source="fakechat"
         image_path="/Users/nehal/.claude/channels/fakechat/inbox/img-a1b2.png"
         image_mime="image/png">
What's causing the blank panel on this screen?
</channel>
```

- **+** Clean, structured, and typed — easy to attach `mime`, `size`, `caption`,
  `source_msg_id`, etc.; trivial for the server to populate programmatically.
- **+** Great for **single-image** messages and for routing metadata generally.
- **−** **Loses positional binding.** XML attributes are unordered and detached from the
  body, so with two images (`image_path_0`, `image_path_1`) Claude has to *guess*
  which one "the top screenshot" refers to. Weak exactly where you care most.

## Option C — hybrid: token in `content`, path in `meta`  ← the one you were reaching for

Leave a **named placeholder** in the body at the image's position, and put the actual
path in a meta attribute **of the same name**. Because the attribute is visible in the
tag, Claude resolves token → attribute → path.

```ts
server.notification({
  method: "notifications/claude/channel",
  params: {
    content:
      "The padding regressed: compare {img_before} against {img_after}. " +
      "The gap under the header doubled.",
    meta: {
      img_before: "/Users/nehal/.claude/channels/fakechat/inbox/before-9f.png",
      img_after:  "/Users/nehal/.claude/channels/fakechat/inbox/after-9f.png",
    },
  },
});
```

Renders as:

```xml
<channel source="fakechat"
         img_before="/Users/nehal/.claude/channels/fakechat/inbox/before-9f.png"
         img_after="/Users/nehal/.claude/channels/fakechat/inbox/after-9f.png">
The padding regressed: compare {img_before} against {img_after}. The gap under the header doubled.
</channel>
```

- **+** Keeps **both** properties: the token marks *where* each image belongs (position
  preserved, like Option A) **and** the path lives in structured meta (clean +
  typeable, like Option B).
- **+** The delimiter is arbitrary — `{img_before}`, `@img_before`, `:img_before:` all
  work; Claude just needs the body name to match a meta key. Since meta keys are already
  identifiers (no hyphens), your placeholder names naturally look like `img_before`,
  `shot_0`, `log_tail`.
- **−** Slightly more server logic (allocate a name, emit it in both places).
- Note: this is a *convention you and Claude share within a message*, not a formal
  templating feature Claude Code interpolates. It works because the model sees the
  attribute value in the tag and maps it — reliable, but worth a one-line hint in the
  body (e.g. "{img_before}/{img_after} are attached image paths") if you want to be
  explicit.

## Option D — lazy / tool-mediated (the Discord pattern)

Instead of a path, pass an **id** plus metadata, and expose a `download_attachment`
tool. Claude fetches the bytes only if it decides it needs them. (Discord's official
plugin works this way — it surfaces name/type/size and downloads on demand rather than
auto-saving.)

```ts
server.notification({
  method: "notifications/claude/channel",
  params: {
    content: "New attachment on the deploy thread: {att_7} — check if it's the failing config.",
    meta: {
      att_7: "att_7",           // id the download tool understands
      att_7_name: "prod.yaml",
      att_7_type: "text/yaml",
      att_7_bytes: "8123",
    },
  },
});
// + a registered reply-side tool: download_attachment(id) → writes to disk / returns content
```

- **+** Don't pay (bandwidth, disk, context) to materialize files Claude never opens —
  the model decides. Best when attachments are many, large, or usually irrelevant.
- **+** Still supports positional reference via the same token trick.
- **−** Extra round-trip and a tool to implement; overkill for a single small screenshot.

---

## Picking one

| Situation | Best option |
|---|---|
| One image, don't care about prose cleanliness | **A** (inline path) |
| One image, want clean body + typed metadata | **B** (path in meta) |
| Two or more images referenced positionally in the text | **C** (token + meta) |
| Many/large/often-unused attachments | **D** (id + download tool) |

**Recommendation for your case:** you said you want the position clear, which rules out
plain Option B for anything multi-image. Between A and C:

- If a message usually has **one** image and you don't mind the raw path in the
  sentence, **A** is the least code and completely unambiguous.
- If you want position preserved **and** a clean, structured body (and room to carry
  `mime`/`caption`/`size` per image), **C** is the sweet spot — it's the "refer to the
  meta field from content" mechanism you were looking for, and it degrades gracefully to
  A if you ever inline a real path instead of a token.

There is no way to make an attribute *positional on its own* — XML attributes have no
location in the body — so if position matters you must leave *something* at that spot in
`content`. Your only real choice is whether that something is the **full path (A)** or a
**short named token backed by meta (C)**. Everything else is a variation on those two.

## Gotchas

- **Absolute paths.** The channel subprocess and the Claude Code session share a
  filesystem, but not necessarily a CWD you can predict — emit absolute paths (the
  `~/.claude/channels/<plugin>/inbox/…` convention is a good home).
- **Identifier keys only.** `img_before` ✔, `img-before` ✖ (a hyphenated key is dropped).
  Same rule makes hyphen-free placeholder names the path of least resistance.
- **Claude still has to open it.** None of these auto-render the image into the model's
  vision; the path/id arrives as text and Claude calls Read/View on it. If you want the
  image looked at, say so in the body ("open the attached screenshot and …").
- **Preview churn.** The notification contract is explicitly marked unstable for the
  research preview; keep a thin adapter between your server logic and the raw
  `notifications/claude/channel` call so a schema change is a one-file edit.

## Sources

- Channels reference (notification format, meta rules): `code.claude.com/docs/en/channels-reference`
- Push events into a session (fakechat flow, `<channel>` tag): `code.claude.com/docs/en/channels`
- fakechat plugin (inbox path included in notification): `github.com/anthropics/claude-plugins-official` → `external_plugins/fakechat`
