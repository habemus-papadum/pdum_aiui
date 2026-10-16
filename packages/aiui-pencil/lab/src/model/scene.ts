/** A scrollable DOM fixture under a fixed ink view. Content mapping is explicit. */
import {
  applyNavigationTransform,
  bindInkAttachment,
  type InkAttachment,
  type InkTransform,
  type PencilSurface,
} from "@habemus-papadum/aiui-pencil";
import type { PadRenderer } from "./pad-renderer";

export interface LabSceneState {
  content: InkTransform;
  ink: InkTransform;
  scrollLeft: number;
  scrollTop: number;
}

interface State<T> {
  get(): T;
  set(value: T): void;
}

export interface LabSceneOptions {
  paper: PencilSurface;
  pad: PadRenderer;
  state: State<LabSceneState>;
  valid: State<boolean>;
  linked(): boolean;
  width(): number;
}

/** These are view coordinates; changing them never moves or rewrites source stroke samples. */
export class LabScene {
  private host?: HTMLElement;
  private scroller?: HTMLElement;
  private content?: HTMLElement;
  private attachment?: InkAttachment;
  private width: number;
  private state: LabSceneState;
  private valid: boolean;
  private linked: boolean;
  private readonly options: LabSceneOptions;

  constructor(options: LabSceneOptions) {
    this.options = options;
    this.width = options.width();
    this.state = options.state.get();
    this.valid = options.valid.get();
    this.linked = options.linked();
  }

  mount(host: HTMLElement): void {
    const scroller = host.querySelector<HTMLElement>(".scene-scroll");
    const content = host.querySelector<HTMLElement>(".scene-content");
    if (!scroller || !content) throw new Error("Drawing scene content is missing");
    if (this.host) this.unmount(this.host);
    this.host = host;
    this.scroller = scroller;
    this.content = content;
    const { paper, pad } = this.options;
    host.append(paper.canvas);
    pad.mount(host);
    paper.canvas.style.visibility = "";
    pad.canvas.style.visibility = "";
    this.paintContent();
    this.scroller.scrollLeft = this.state.scrollLeft;
    this.scroller.scrollTop = this.state.scrollTop;
    this.scroller.addEventListener("scroll", this.scrolled);
    paper.canvas.addEventListener("wheel", this.wheel, { passive: false });
    this.attachment = bindInkAttachment({
      surface: {
        canvas: paper.canvas,
        setViewport: (viewport) => paper.setViewport(viewport),
        setActive: (active) => {
          paper.setActive(active);
          pad.canvas.style.visibility = active ? "" : "hidden";
          if (active) pad.invalidate();
        },
      },
      scrollTarget: this.scroller,
      viewport: () => this.mappedViewport(),
      resizeTargets: [host],
    });
    if (!this.valid) this.attachment.invalidate();
    this.scrolled();
  }

  unmount(host: HTMLElement): void {
    if (this.host !== host) return;
    this.attachment?.dispose();
    this.attachment = undefined;
    this.scroller?.removeEventListener("scroll", this.scrolled);
    this.options.paper.canvas.removeEventListener("wheel", this.wheel);
    this.options.pad.unmount(host);
    if (this.options.paper.canvas.parentElement === host) this.options.paper.canvas.remove();
    this.host = undefined;
    this.scroller = undefined;
    this.content = undefined;
  }

  dispose(): void {
    if (this.host) this.unmount(this.host);
  }

  /** Surface gestures already changed the ink view; follow them with DOM content when linked. */
  viewportChanged(viewport: InkTransform): void {
    const previous = this.state;
    const scrollLeft = this.scroller?.scrollLeft ?? previous.scrollLeft;
    const scrollTop = this.scroller?.scrollTop ?? previous.scrollTop;
    this.publishState({
      ...previous,
      ink: { ...viewport },
      content: this.linked
        ? { ...viewport, x: viewport.x + scrollLeft, y: viewport.y + scrollTop }
        : previous.content,
      scrollLeft,
      scrollTop,
    });
    this.paintContent();
    this.options.pad.invalidate();
  }

  linkedChanged(linked: boolean): void {
    this.linked = linked;
    this.applyLinkedMapping();
    this.attachment?.refresh();
    this.options.pad.invalidate();
  }

  /** A DOM width change reflows text/cards; no uniform ink mapping can infer those moves. */
  reflow(width: number): void {
    if (width === this.width) return;
    this.width = width;
    const ink = this.options.paper.document.snapshot();
    if (ink.strokes.length || ink.live.length) {
      this.valid = false;
      this.options.valid.set(this.valid);
      this.attachment?.invalidate();
    }
    this.paintContent();
  }

  resume(): void {
    this.valid = true;
    this.options.valid.set(this.valid);
    this.attachment?.resume();
    this.options.pad.invalidate();
  }

  scrollBy(y: number): void {
    if (!this.scroller) return;
    this.scroller.scrollTop += y;
    this.scrolled();
  }

  navigate(dx: number, dy: number, scale = 1, rotation = 0): void {
    if (!this.valid) return;
    const { paper } = this.options;
    const from = { x: paper.canvas.clientWidth / 2, y: paper.canvas.clientHeight / 2 };
    const viewport = applyNavigationTransform(
      paper.view.getViewport(),
      { from, to: { x: from.x + dx, y: from.y + dy }, scale, rotation },
      { minScale: 0.1, maxScale: 10 },
    );
    paper.setViewport(viewport);
  }

  /** Move the reference page alone; its native scroll offset stays unchanged. */
  navigateContent(dx: number, dy: number, scale = 1, rotation = 0): void {
    if (this.linked) {
      this.navigate(dx, dy, scale, rotation);
      return;
    }
    if (!this.valid) return;
    const { paper } = this.options;
    const previous = this.state;
    const scrollLeft = this.scroller?.scrollLeft ?? previous.scrollLeft;
    const scrollTop = this.scroller?.scrollTop ?? previous.scrollTop;
    const from = { x: paper.canvas.clientWidth / 2, y: paper.canvas.clientHeight / 2 };
    const viewport = applyNavigationTransform(
      {
        ...previous.content,
        x: previous.content.x - scrollLeft,
        y: previous.content.y - scrollTop,
      },
      { from, to: { x: from.x + dx, y: from.y + dy }, scale, rotation },
      { minScale: 0.1, maxScale: 10 },
    );
    this.publishState({
      ...previous,
      content: { ...viewport, x: viewport.x + scrollLeft, y: viewport.y + scrollTop },
      scrollLeft,
      scrollTop,
    });
    this.paintContent();
  }

  resetView(): void {
    const identity = { x: 0, y: 0, scale: 1, rotation: 0 };
    this.publishState({ content: identity, ink: identity, scrollLeft: 0, scrollTop: 0 });
    if (this.scroller) {
      this.scroller.scrollLeft = 0;
      this.scroller.scrollTop = 0;
    }
    this.paintContent();
    this.options.paper.setViewport(identity);
    this.attachment?.refresh();
    this.options.pad.invalidate();
  }

  private mappedViewport(): InkTransform {
    const state = this.state;
    if (!this.linked) return state.ink;
    return {
      ...state.content,
      x: state.content.x - (this.scroller?.scrollLeft ?? state.scrollLeft),
      y: state.content.y - (this.scroller?.scrollTop ?? state.scrollTop),
    };
  }

  private paintContent(): void {
    if (!this.content) return;
    const transform = this.state.content;
    const a = Math.cos(transform.rotation ?? 0) * transform.scale;
    const b = Math.sin(transform.rotation ?? 0) * transform.scale;
    this.content.style.transform = `matrix(${a}, ${b}, ${-b}, ${a}, ${transform.x}, ${transform.y})`;
    this.content.style.width = `${this.width}px`;
    this.content.dataset.layout = this.width < 500 ? "narrow" : "wide";
  }

  private scrolled = (): void => {
    if (!this.scroller) return;
    const previous = this.state;
    this.publishState({
      ...previous,
      scrollLeft: this.scroller.scrollLeft,
      scrollTop: this.scroller.scrollTop,
    });
    this.applyLinkedMapping();
    this.attachment?.refresh();
    this.options.pad.invalidate();
  };

  /** Gestures may change the surface outside the attachment's scroll listener. */
  private applyLinkedMapping(): void {
    if (!this.linked || !this.valid) return;
    const desired = this.mappedViewport();
    const actual = this.options.paper.view.getViewport();
    if (
      actual.x !== desired.x ||
      actual.y !== desired.y ||
      actual.scale !== desired.scale ||
      (actual.rotation ?? 0) !== (desired.rotation ?? 0)
    ) {
      this.options.paper.setViewport(desired);
    }
  }

  /** Solid observes published snapshots; browser event coordination uses synchronous state. */
  private publishState(state: LabSceneState): void {
    this.state = state;
    this.options.state.set(state);
  }

  /** Wheel motion changes real scrollTop/scrollLeft beneath the fixed input canvas. */
  private wheel = (event: WheelEvent): void => {
    if (!this.scroller || event.ctrlKey) return;
    const unit =
      event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.scroller.clientHeight : 1;
    this.scroller.scrollLeft += event.deltaX * unit;
    this.scroller.scrollTop += event.deltaY * unit;
    this.scrolled();
    event.preventDefault();
  };
}
