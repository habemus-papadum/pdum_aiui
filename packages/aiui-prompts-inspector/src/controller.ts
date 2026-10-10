import {
  type CompiledPrompt,
  parseRecord,
  rehydrate,
  type SemanticRecord,
} from "@habemus-papadum/aiui-prompts";
import { type InspectionDocument, type InspectionLoadOptions, loadInspection } from "./history.ts";
import type { OutputRange } from "./preview.ts";
import { createState, ownersOfRange, parentChain } from "./state.ts";

export class InspectorController {
  record: SemanticRecord | null = null;
  compiled: CompiledPrompt | null = null;
  error: string | null = null;
  document: InspectionDocument | null = null;
  recordKey: string | null = null;
  readonly state = createState();
  #disposed = false;
  #listeners = new Set<() => void>();

  constructor(input: unknown, options: InspectionLoadOptions = {}) {
    this.load(input, options);
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** A failed import reports its error without replacing the last validated record/view state. */
  load(input: unknown, options: InspectionLoadOptions = {}): boolean {
    if (this.#disposed) return false;
    this.error = null;
    try {
      const document = loadInspection(input, options);
      const binding = document.bindings[0];
      const record = binding?.record ?? null;
      const compiled = record ? rehydrate(record) : null;
      this.document = document;
      this.recordKey = binding?.key ?? null;
      this.record = record;
      this.compiled = compiled;
      this.state.selected = null;
      this.state.contentFolded.clear();
      this.state.outlineCollapsed.clear();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.#notify();
    return this.error === null;
  }

  /** Switch an operation's binding without rebuilding or flattening message history. */
  selectRecord(key: string): boolean {
    if (this.#disposed) return false;
    const binding = this.document?.bindings.find((item) => item.key === key);
    if (!binding) return false;
    try {
      const compiled = rehydrate(binding.record);
      this.record = binding.record;
      this.recordKey = key;
      this.compiled = compiled;
      this.error = null;
      this.state.selected = null;
      this.state.contentFolded.clear();
      this.state.outlineCollapsed.clear();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.#notify();
    return this.error === null;
  }

  recompile(): boolean {
    if (this.#disposed || !this.record) return false;
    try {
      // JSON round trip demonstrates storage re-derivation, not retained author closures.
      this.compiled = rehydrate(parseRecord(JSON.stringify(this.record)));
      this.error = null;
    } catch (error) {
      this.compiled = null;
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.#notify();
    return this.error === null;
  }

  select(id: string | null): void {
    if (this.#disposed || !this.compiled) return;
    if (id !== null && !this.compiled.occurrences.some((item) => item.id === id)) return;
    this.state.selected = id;
    if (id !== null) {
      for (const parent of parentChain(this.compiled, id))
        this.state.outlineCollapsed.delete(parent);
    }
    this.#notify();
  }

  selectRange(range: OutputRange): readonly string[] {
    if (this.#disposed || !this.compiled) return [];
    const owners = ownersOfRange(this.compiled, range);
    this.select(owners[0] ?? null);
    return owners;
  }

  toggleOutline(id: string): void {
    this.#toggle(this.state.outlineCollapsed, id);
  }

  toggleFold(id: string): void {
    this.#toggle(this.state.contentFolded, id);
  }

  unfoldAll(): void {
    if (this.#disposed) return;
    this.state.contentFolded.clear();
    this.#notify();
  }

  subscribe(listener: () => void): () => void {
    if (this.#disposed) return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
  }

  #toggle(set: Set<string>, id: string): void {
    if (this.#disposed || !this.compiled?.occurrences.some((item) => item.id === id)) return;
    if (set.has(id)) set.delete(id);
    else set.add(id);
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}
