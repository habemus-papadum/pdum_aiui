/** Convenience composition of editable ink, browser input, presentation, and view. */
import { createInkDocument, type InkDocument, type InkStroke, type InkTool } from "./document";
import { applyNavigationTransform, type InkTransform, type NavigationTransform } from "./geometry";
import { bindPenInput, type PenInputBinding, type PenInputOptions } from "./input/pointer";
import type { PencilParams } from "./pencil";
import { InkPresentation } from "./presentation";
import { CanvasInkView } from "./renderer";

export interface PencilNavigationOptions {
  enabled?: boolean | (() => boolean);
  pan?: boolean | (() => boolean);
  zoom?: boolean | (() => boolean);
  rotate?: boolean | (() => boolean);
  /** Absolute viewport scale limits; defaults to 0.1 and 10. */
  minScale?: number;
  maxScale?: number;
}

const enabled = (option: boolean | (() => boolean) | undefined) =>
  typeof option === "function" ? option() : (option ?? true);

export interface PencilSurfaceOptions {
  target?: HTMLElement;
  document?: InkDocument;
  params: () => PencilParams;
  tool?: () => InkTool;
  localInput?: boolean;
  inputOptions?: Omit<PenInputOptions, "sink" | "clientToInk" | "bounds">;
  /** Two-finger navigation defaults on in Pencil mode, after lifting the pen. */
  navigation?: boolean | PencilNavigationOptions;
  /** Keep an application's underlying content aligned with the ink viewport. */
  onViewportChange?: (viewport: InkTransform, reason: "gesture" | "external") => void;
  className?: string;
  background?: () => string | undefined;
  fadeSec?: () => number;
  fadeCurve?: () => "warp" | "crossfade";
  expireFadedInk?: boolean;
  cacheBytes?: number;
  onStrokeStart?: (id: string, tool: InkTool) => void;
  onStrokeEnd?: (stroke: InkStroke) => void;
  onStrokeCancel?: (id: string) => void;
}
export class PencilSurface {
  readonly document: InkDocument;
  readonly presentation: InkPresentation;
  readonly view: CanvasInkView;
  readonly input?: PenInputBinding;
  private unsubscribe: () => void;
  constructor(private options: PencilSurfaceOptions) {
    this.document = options.document ?? createInkDocument();
    this.presentation = new InkPresentation(this.document);
    this.refresh();
    this.view = new CanvasInkView({
      document: this.document,
      presentation: this.presentation,
      target: options.target ?? document.body,
      className: options.className,
      background: options.background,
      cacheBytes: options.cacheBytes,
    });
    this.unsubscribe = this.document.subscribe((change) => {
      if (change.kind === "begin") {
        for (const id of change.ids) {
          const draft = change.snapshot.live.find((stroke) => stroke.id === id);
          if (draft) options.onStrokeStart?.(id, draft.tool);
        }
      } else if (change.kind === "finish") {
        const stroke = change.snapshot.strokes.find((stroke) => stroke.id === change.inputId);
        if (stroke) options.onStrokeEnd?.(stroke);
      } else if (change.kind === "cancel") {
        if (change.inputId) options.onStrokeCancel?.(change.inputId);
      }
    });
    if (options.localInput !== false)
      this.input = bindPenInput(this.canvas, {
        ...options.inputOptions,
        clientToInk: (sample) => ({
          ...sample,
          ...this.view.clientToInk(sample),
          // Captured lean belongs to ink space, so the view does not rotate it twice.
          azimuth:
            (((sample.azimuth - (this.view.getViewport().rotation ?? 0)) % (2 * Math.PI)) +
              2 * Math.PI) %
            (2 * Math.PI),
        }),
        navigation: () =>
          this.navigationEnabled() && (options.inputOptions?.navigation?.() ?? true),
        onNavigate: (navigation) => {
          this.navigate(navigation);
          options.inputOptions?.onNavigate?.(navigation);
        },
        sink: {
          begin: (id, point) =>
            this.document.begin(id, {
              point,
              params: options.params(),
              tool: options.tool?.() ?? "draw",
            }),
          points: (id, points) => this.document.append(id, points),
          end: (id, point) => this.document.finish(id, point),
          cancel: (id) => this.document.cancel(id),
        },
      });
  }
  get canvas(): HTMLCanvasElement {
    return this.view.canvas;
  }
  setActive(active: boolean): void {
    this.input?.setEnabled(active);
    this.canvas.style.pointerEvents = active && this.input ? "auto" : "none";
    this.view.setActive(active);
  }
  setViewport(viewport: InkTransform): void {
    this.input?.cancel();
    this.view.setViewport(viewport);
    this.options.onViewportChange?.(this.view.getViewport(), "external");
  }
  private navigationEnabled(): boolean {
    const navigation = this.options.navigation;
    return (
      !!this.input?.penEnabled() &&
      navigation !== false &&
      (typeof navigation !== "object" || enabled(navigation.enabled))
    );
  }
  private navigate(navigation: NavigationTransform): void {
    const config = typeof this.options.navigation === "object" ? this.options.navigation : {};
    const current = this.view.getViewport();
    const zoom = enabled(config.zoom);
    const next = applyNavigationTransform(
      current,
      {
        ...navigation,
        to: enabled(config.pan) ? navigation.to : navigation.from,
        scale: zoom ? navigation.scale : 1,
        rotation: enabled(config.rotate) ? navigation.rotation : 0,
      },
      zoom ? { minScale: config.minScale ?? 0.1, maxScale: config.maxScale ?? 10 } : {},
    );
    if (
      next.x === current.x &&
      next.y === current.y &&
      next.scale === current.scale &&
      (next.rotation ?? 0) === (current.rotation ?? 0)
    )
      return;
    // The gesture keeps its captures. Public setViewport cancels contacts for external moves.
    this.view.setViewport(next);
    this.options.onViewportChange?.(this.view.getViewport(), "gesture");
  }
  /** Refresh appearance options after application controls change. */
  refresh(): void {
    this.presentation.configure({
      durationMs: (this.options.fadeSec?.() ?? 0) * 1000,
      curve: this.options.fadeCurve?.() ?? "warp",
      expire: this.options.expireFadedInk ?? false,
    });
    this.view?.invalidate();
  }
  fadeCompleted(durationSec = 0.5, remove = true): void {
    this.presentation.fadeOut(this.document.capture(), durationSec * 1000, remove);
  }
  dispose(): void {
    try {
      this.input?.dispose();
    } finally {
      this.unsubscribe();
      this.presentation.dispose();
      this.view.dispose();
    }
  }
}
