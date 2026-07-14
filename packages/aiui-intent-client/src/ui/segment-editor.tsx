/**
 * segment-editor.tsx — the popup that fixes a turn's text (owner spec,
 * 2026-07-14). Three edits, one surface:
 *
 *  1. **Fix a transcript segment** — one segment at a time (one hands-free
 *     session / one push-to-talk hold). The popup shows the segment's full
 *     text with its interleaved items as ATOMIC EMOJI (non-editable spans:
 *     they move whole or die — no text, no partial edits). Moving one is
 *     IGNORED (positions are the compiler's, from timestamps); deleting one
 *     is a delete command (the same drop verbs as the preview's ✕). Apply
 *     re-timestamps the new text against the old words (edit/retime.ts) and
 *     speaks `segment-replace`; the pipeline reflows the images.
 *  2. **Paste text** — anywhere inside the text (plain, or Markdown when the
 *     clipboard carries useful HTML — edit/html-md.ts), or at the END of the
 *     turn via the append mode (an ordinary contribution).
 *  3. **Paste an image** — an atom appears at the paste position; Apply
 *     uploads it and emits a shot with `origin: "paste"` and a synthetic
 *     `takenAt` derived from the words around the atom, so the compiler's
 *     OWN interleave places it — mid-segment placement costs no new logic.
 *     (A segment with no talk window — a typed contribution — has nothing to
 *     anchor against; its pastes keep arrival order. Honest limitation.)
 *
 * The contenteditable surface is a deliberate imperative island (like the
 * preview's peek): atomicity and exact identity need real DOM — each atom is
 * `contenteditable=false` carrying its marker in a data attribute, so "which
 * 🖼 did they delete" is never ambiguous. The pure halves — building the
 * snapshot, collecting the surface, planning the edit — are exported and
 * tested without the component.
 */

import {
  composeIntent,
  type IntentEvent,
  type TranscriptWord,
} from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import { onCleanup } from "solid-js";
import { htmlToMarkdown } from "../edit/html-md";
import { retimeWords } from "../edit/retime";
import type { ChannelLanes } from "../lanes";

export const SEGMENT_EDITOR_STYLES = `
  .aiui-se-overlay { position: fixed; inset: 0; z-index: 2147483645;
    background: rgba(0, 0, 0, 0.45); display: flex; align-items: center; justify-content: center; }
  .aiui-se-card { width: min(560px, 92vw); background: #14171f; border-radius: 10px;
    border: 1px solid #3a4152; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
    padding: 12px; font: 13px/1.5 system-ui; color: #e8e8ea; }
  .aiui-se-title { font-size: 11px; opacity: 0.6; margin-bottom: 8px; }
  .aiui-se-text { min-height: 88px; max-height: 50vh; overflow-y: auto; outline: none;
    border: 1px solid #3a4152; border-radius: 6px; padding: 8px 10px; white-space: pre-wrap;
    word-break: break-word; }
  .aiui-se-text:focus { border-color: #8ab4f8; }
  .aiui-se-atom { display: inline-block; margin: 0 2px; padding: 0 2px; border-radius: 4px;
    background: color-mix(in srgb, #ffd166 16%, transparent); cursor: default; }
  .aiui-se-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 10px; }
  .aiui-se-actions button { font: 12px system-ui; padding: 3px 12px; border-radius: 6px;
    border: 1px solid #3a4152; background: transparent; color: inherit; cursor: pointer; }
  .aiui-se-actions button.primary { background: #7c3aed; border-color: #7c3aed; color: #fff; }
  .aiui-se-hint { font-size: 11px; opacity: 0.55; margin-top: 6px; }
`;

/** One atomic (move-whole-or-delete) item as the editor sees it. */
export interface EditorAtom {
  itemKind: "shot" | "app-selection" | "code-selection";
  marker: string;
}

export type EditorBlock = { kind: "text"; text: string } | { kind: "atom"; atom: EditorAtom };

/** What one segment looks like to the editor. */
export interface SegmentSnapshot {
  segment: number;
  /** Text runs and atoms, in composed (interleaved) order. */
  blocks: EditorBlock[];
  /** The segment's latest word timestamps — the retime anchors. */
  oldWords: TranscriptWord[];
  /** talk-start wall-clock — what pasted images anchor against. */
  windowStart?: number;
}

const ATOM_EMOJI: Record<EditorAtom["itemKind"], string> = {
  shot: "🖼",
  "app-selection": "📋",
  "code-selection": "📄",
};

/** Build the editor's view of one segment from the thread's events. Pure. */
export function segmentSnapshot(
  events: IntentEvent[],
  segment: number,
): SegmentSnapshot | undefined {
  const items = composeIntent(events, "replace", { streaming: true }).items;
  const indexes = items
    .map((item, index) => (item.kind === "text" && item.segment === segment ? index : -1))
    .filter((index) => index !== -1);
  if (indexes.length === 0) {
    return undefined;
  }
  const blocks: EditorBlock[] = [];
  for (let i = indexes[0]; i <= indexes[indexes.length - 1]; i++) {
    const item = items[i];
    if (item.kind === "text" && item.segment === segment) {
      blocks.push({ kind: "text", text: item.text ?? "" });
    } else if (
      (item.kind === "shot" || item.kind === "app-selection" || item.kind === "code-selection") &&
      item.marker !== undefined
    ) {
      blocks.push({ kind: "atom", atom: { itemKind: item.kind, marker: item.marker } });
    }
  }

  // The latest words + talk window for the segment, straight off the stream.
  let oldWords: TranscriptWord[] = [];
  let windowStart: number | undefined;
  for (const event of events) {
    if (event.type === "talk-start" && event.segment === segment) {
      windowStart = event.at;
    } else if (
      (event.type === "transcript-final" || event.type === "segment-replace") &&
      event.segment === segment &&
      event.words !== undefined
    ) {
      oldWords = event.words;
    }
  }
  return {
    segment,
    blocks,
    oldWords,
    ...(windowStart !== undefined ? { windowStart } : {}),
  };
}

/** What the user left on the surface: normalized text, surviving atoms (with
 * their TOKEN position), and new image pastes (with theirs). */
export interface CollectedEdit {
  text: string;
  atoms: Array<EditorAtom & { tokenIndex: number }>;
  pastes: Array<{ pasteId: string; tokenIndex: number }>;
}

const tokenize = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/** Walk the editable surface. DOM in, plain data out. */
export function collectEditable(root: HTMLElement): CollectedEdit {
  const parts: string[] = [];
  const atoms: CollectedEdit["atoms"] = [];
  const pastes: CollectedEdit["pastes"] = [];
  const tokensSoFar = (): number => tokenize(parts.join(" ")).length;
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? "");
      return;
    }
    if (!(node instanceof HTMLElement)) {
      return;
    }
    const marker = node.dataset.marker;
    const pasteId = node.dataset.pasteId;
    if (pasteId !== undefined) {
      pastes.push({ pasteId, tokenIndex: tokensSoFar() });
      return;
    }
    if (marker !== undefined) {
      atoms.push({
        itemKind: (node.dataset.itemKind ?? "shot") as EditorAtom["itemKind"],
        marker,
        tokenIndex: tokensSoFar(),
      });
      return;
    }
    for (const child of Array.from(node.childNodes)) {
      walk(child);
    }
  };
  walk(root);
  return { text: tokenize(parts.join(" ")).join(" "), atoms, pastes };
}

/** The plan an Apply executes. Pure — this is where the semantics live. */
export interface EditPlan {
  /** New text + retimed words, when the text actually changed. */
  replace?: { text: string; words: TranscriptWord[] };
  /** Atoms the user deleted (moves are ignored — order/position changes are
   * not commands; the compiler owns positions). */
  deleted: EditorAtom[];
  /** New image pastes with their synthetic anchor (absent = end of stream). */
  pastes: Array<{ pasteId: string; takenAt?: number }>;
}

export function planEdit(snapshot: SegmentSnapshot, collected: CollectedEdit): EditPlan {
  const originalText = snapshot.blocks
    .filter((b): b is Extract<EditorBlock, { kind: "text" }> => b.kind === "text")
    .map((b) => b.text)
    .join(" ");
  const changed = tokenize(originalText).join(" ") !== collected.text;
  const words = changed ? retimeWords(snapshot.oldWords, collected.text) : undefined;

  const survivors = new Set(collected.atoms.map((a) => a.marker));
  const deleted = snapshot.blocks
    .filter((b): b is Extract<EditorBlock, { kind: "atom" }> => b.kind === "atom")
    .map((b) => b.atom)
    .filter((atom) => !survivors.has(atom.marker));

  // A pasted image anchors to the END of the word before it: takenAt =
  // windowStart + that word's endMs. The compiler's interleave does the rest.
  const timedWords = words ?? snapshot.oldWords;
  const pastes = collected.pastes.map(({ pasteId, tokenIndex }) => {
    if (snapshot.windowStart === undefined) {
      return { pasteId }; // no talk window (typed contribution): arrival order
    }
    const anchorMs =
      tokenIndex > 0 ? (timedWords[Math.min(tokenIndex, timedWords.length) - 1]?.endMs ?? 0) : 0;
    return { pasteId, takenAt: snapshot.windowStart + anchorMs };
  });

  return {
    ...(changed && collected.text !== ""
      ? { replace: { text: collected.text, words: words ?? [] } }
      : {}),
    deleted,
    pastes,
  };
}

/** Cap a pasted image into a thumb the preview can render inline. */
async function thumbFor(blob: Blob): Promise<{ thumb: string; w: number; h: number }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 360 / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) {
      return { thumb: dataUrl, w: bitmap.width, h: bitmap.height };
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { thumb: canvas.toDataURL("image/jpeg", 0.6), w: bitmap.width, h: bitmap.height };
  } catch {
    return { thumb: dataUrl, w: 0, h: 0 }; // jsdom / decode failure: full image
  }
}

/** Emit one pasted image into the turn: the shot event (origin "paste",
 * synthetic anchor) + the attachment upload. */
async function emitPaste(lanes: ChannelLanes, blob: Blob, takenAt?: number): Promise<void> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { thumb, w, h } = await thumbFor(blob);
  const marker = lanes.engine.shotDone(
    { x: 0, y: 0, w, h },
    [],
    thumb,
    undefined,
    false,
    takenAt,
    undefined,
    "paste",
  );
  await lanes.wire.uploadAttachment(marker, blob.type || "image/png", bytes);
}

export type EditorMode = { kind: "segment"; segment: number } | { kind: "append" };

/**
 * The popup. Append mode is the same surface with no snapshot: text becomes a
 * contribution, pastes anchor at the end.
 */
export function SegmentEditor(props: {
  lanes: ChannelLanes;
  mode: EditorMode;
  onClose: () => void;
}) {
  const snapshot =
    props.mode.kind === "segment"
      ? segmentSnapshot(props.lanes.threadEvents(), props.mode.segment)
      : undefined;
  const pasteBlobs = new Map<string, Blob>();
  let pasteCounter = 0;

  // The editable surface — built imperatively ONCE (contenteditable is an
  // imperative API; Solid renders around it, not inside it).
  const editable = document.createElement("div");
  editable.className = "aiui-se-text";
  editable.contentEditable = "true";
  editable.setAttribute("role", "textbox");
  editable.setAttribute("aria-multiline", "true");
  const atomSpan = (emoji: string, data: Record<string, string>): HTMLSpanElement => {
    const span = document.createElement("span");
    span.className = "aiui-se-atom";
    span.contentEditable = "false";
    for (const [key, value] of Object.entries(data)) {
      span.dataset[key] = value;
    }
    span.textContent = emoji;
    return span;
  };
  for (const block of snapshot?.blocks ?? []) {
    if (block.kind === "text") {
      editable.append(document.createTextNode(`${block.text} `));
    } else {
      editable.append(
        atomSpan(ATOM_EMOJI[block.atom.itemKind], {
          marker: block.atom.marker,
          itemKind: block.atom.itemKind,
        }),
      );
      editable.append(document.createTextNode(" "));
    }
  }

  const insertAtSelection = (node: Node): void => {
    const selection = editable.ownerDocument.getSelection();
    const range =
      selection !== null && selection.rangeCount > 0 && editable.contains(selection.anchorNode)
        ? selection.getRangeAt(0)
        : undefined;
    if (range !== undefined) {
      range.deleteContents();
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
    } else {
      editable.append(node);
    }
  };

  editable.addEventListener("paste", (event) => {
    event.preventDefault();
    const data = event.clipboardData;
    if (data === null) {
      return;
    }
    const image = Array.from(data.items).find((item) => item.type.startsWith("image/"));
    const file = image?.getAsFile();
    if (file != null) {
      const pasteId = `paste_${++pasteCounter}`;
      pasteBlobs.set(pasteId, file);
      insertAtSelection(atomSpan("🖼", { pasteId }));
      return;
    }
    // Rich text becomes Markdown when that gains anything; else plain.
    const html = data.getData("text/html");
    const markdown = html !== "" ? htmlToMarkdown(html) : undefined;
    const text = markdown ?? data.getData("text/plain");
    if (text !== "") {
      insertAtSelection(document.createTextNode(text));
    }
  });

  const apply = (): void => {
    const collected = collectEditable(editable);
    if (props.mode.kind === "segment" && snapshot !== undefined) {
      const plan = planEdit(snapshot, collected);
      if (plan.replace !== undefined) {
        props.lanes.engine.replaceSegment(snapshot.segment, plan.replace.text, plan.replace.words);
      }
      for (const atom of plan.deleted) {
        if (atom.itemKind === "shot") {
          props.lanes.engine.dropShot(atom.marker);
        } else if (atom.itemKind === "app-selection") {
          props.lanes.engine.appSelectionDrop(atom.marker);
        } else {
          props.lanes.engine.dropCodeSelection(atom.marker);
        }
      }
      for (const paste of plan.pastes) {
        const blob = pasteBlobs.get(paste.pasteId);
        if (blob !== undefined) {
          void emitPaste(props.lanes, blob, paste.takenAt);
        }
      }
    } else {
      // Append mode: text is a contribution; pastes land at the end.
      if (collected.text !== "") {
        props.lanes.engine.contribute(collected.text);
      }
      for (const paste of collected.pastes) {
        const blob = pasteBlobs.get(paste.pasteId);
        if (blob !== undefined) {
          void emitPaste(props.lanes, blob);
        }
      }
    }
    props.onClose();
  };

  // The popup claims Esc AHEAD of the panel's ladder while open (capture on
  // the document — the shell's own listener must not step the machine out
  // underneath an open editor). ⌘Enter applies.
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      props.onClose();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      apply();
    }
  };
  document.addEventListener("keydown", onKey, true);
  onCleanup(() => document.removeEventListener("keydown", onKey, true));

  queueMicrotask(() => editable.focus());

  return (
    <div class="aiui-se-overlay" data-testid="segment-editor">
      <div class="aiui-se-card">
        <div class="aiui-se-title">
          {props.mode.kind === "segment"
            ? `edit segment ${props.mode.segment} — emoji are the images/selections: delete one to remove it (moves are ignored)`
            : "add to the turn — type or paste (text and images)"}
        </div>
        {editable}
        <div class="aiui-se-hint">paste images or rich text directly · ⌘⏎ apply · esc cancel</div>
        <div class="aiui-se-actions">
          <button type="button" onClick={() => props.onClose()}>
            cancel
          </button>
          <button type="button" class="primary" data-testid="editor-apply" onClick={apply}>
            apply
          </button>
        </div>
      </div>
    </div>
  );
}
