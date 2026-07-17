/**
 * The console dashboard — the channel's landing page. Reads this channel's own
 * facts (same-origin JSON) and lays them out beside the links a person actually
 * wants from here: the pencil client, the standalone panel, the trace debugger.
 */

import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import {
  type ChannelInfo,
  type ChromeInfo,
  fetchChannelInfo,
  fetchHealth,
  type HealthInfo,
} from "./api";
import { CONSOLE_DEBUG_PATH, INTENT_PATH, PENCIL_PATH } from "./routes";
import "./styles.css";

/** One label/value row; the value is monospace, and absent values read "—". */
function Field(props: {
  label: string;
  value?: JSX.Element | string | number | boolean;
}): JSX.Element {
  const shown = () =>
    props.value === undefined || props.value === "" ? "—" : (props.value as JSX.Element);
  return (
    <div class="field">
      <span class="field-label">{props.label}</span>
      <span class="field-value">{shown()}</span>
    </div>
  );
}

function Section(props: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <section class="section">
      <h2>{props.title}</h2>
      <div class="section-body">{props.children}</div>
    </section>
  );
}

function ChromeSection(props: { chrome?: ChromeInfo }): JSX.Element {
  return (
    <Section title="Connected Chrome">
      <Show
        when={props.chrome?.enabled}
        fallback={
          <p class="muted">
            No Chrome DevTools MCP was attached at launch (CI, <code>--aiui-no-chrome</code>, or
            <code> chrome.enabled: false</code>).
          </p>
        }
      >
        <Field label="mode" value={props.chrome?.connection} />
        <Field
          label="debug endpoint"
          value={props.chrome?.browserUrl ?? "(lazy — launched on first tool use)"}
        />
        <Field label="profile" value={props.chrome?.userDataDir} />
        <Field label="binary" value={props.chrome?.executablePath ?? props.chrome?.channel} />
        <Field label="headless" value={props.chrome?.headless === true ? "yes" : "no"} />
        <Show when={props.chrome?.extensionDirs?.length}>
          <Field label="extensions" value={props.chrome?.extensionDirs?.join(", ")} />
        </Show>
      </Show>
    </Section>
  );
}

function LinkCard(props: {
  href: string;
  title: string;
  newWindow?: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <a
      class="link-card"
      href={props.href}
      {...(props.newWindow ? { target: "_blank", rel: "noopener" } : {})}
    >
      <span class="link-title">
        {props.title}
        <Show when={props.newWindow}>
          <span class="link-badge">opens in a new window</span>
        </Show>
      </span>
      <span class="link-desc">{props.children}</span>
    </a>
  );
}

export function Dashboard(): JSX.Element {
  // Two same-origin reads, straight into signals — no resource primitive, so
  // nothing to reason about beyond "undefined until it lands".
  const [info, setInfo] = createSignal<ChannelInfo | undefined>();
  const [health, setHealth] = createSignal<HealthInfo | undefined>();
  void fetchChannelInfo().then(setInfo);
  void fetchHealth().then(setHealth);

  const bind = () => {
    const host = health()?.host;
    if (host === undefined) return undefined;
    return host === "127.0.0.1" ? "loopback (this machine only)" : `host (${host}) — LAN-reachable`;
  };

  return (
    <main class="console">
      <header class="masthead">
        <h1>aiui console</h1>
        <Show when={info()} fallback={<p class="muted">reading channel…</p>}>
          <p class="subtitle">
            <code>{info()?.tag}</code> · channel port <code>{info()?.port}</code>
          </p>
        </Show>
      </header>

      <div class="columns">
        <div class="column">
          <Section title="Channel">
            <Field label="tag" value={info()?.tag} />
            <Field label="port" value={info()?.port} />
            <Field label="bind" value={bind()} />
            <Field label="pid" value={info()?.pid} />
            <Field label="owner (ppid)" value={info()?.ppid} />
            <Field label="cwd" value={info()?.cwd} />
            <Field label="started" value={info()?.startedAt} />
            <Field label="reload generation" value={info()?.generation} />
            <Field label="debug server" value={info()?.debug === true ? "yes" : "no"} />
          </Section>

          <Section title="Launch">
            <Field label="launcher" value={info()?.launch?.launcher ?? "(standalone)"} />
            <Field label="OpenAI key" value={info()?.launch?.openaiKey} />
            <Field label="Gemini key" value={info()?.launch?.geminiKey} />
          </Section>

          <Section title="Live">
            <Field label="page-tools clients" value={health()?.pageTools?.clients} />
            <Field label="registered tools" value={health()?.pageTools?.tools} />
            <Field label="session views" value={health()?.session?.clients} />
            <Field label="session roles" value={health()?.session?.roles?.join(", ")} />
          </Section>
        </div>

        <div class="column">
          <ChromeSection chrome={info()?.launch?.chromeDevtools} />

          <Section title="Surfaces">
            <div class="links">
              <LinkCard href={PENCIL_PATH} title="Pencil client">
                The remote pencil surface — open it on an iPad (same Wi-Fi) to draw on the page over
                the channel. <code>aiui pencil url</code> prints the LAN address and copies it to
                your clipboard.
              </LinkCard>

              <LinkCard href={INTENT_PATH} title="Standalone panel" newWindow>
                The intent client as a plain page, for <strong>advanced debugging</strong>. Prefer
                the Chrome extension side panel for everyday use; reach for this when a workflow
                needs the panel on its own origin.
              </LinkCard>

              <LinkCard href={CONSOLE_DEBUG_PATH} title="Trace debugger">
                The lowering-trace debugger for this channel — inspect each turn's intermediate
                representations, stage by stage.
              </LinkCard>
            </div>
          </Section>
        </div>
      </div>
    </main>
  );
}
