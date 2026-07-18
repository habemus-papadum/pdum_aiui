// <aiui-scenery-file> — this WHOLE FILE is placeholder scenery: delete it on reset (CLAUDE.md § Reset).
/**
 * Banner.tsx — the orientation card. Its one job: make sure a person landing
 * here knows the page is alive and that talking to it is the point. When the
 * user asks for their real app, replace this banner along with the scenery.
 */
export function Banner() {
  return (
    <header class="banner">
      <h1>
        <span class="accent">this page is alive</span> — talk to it
      </h1>
      <p>
        You're looking at a running web app wired to a Claude Code session. Press <kbd>⌘B</kbd> to
        activate the intent client, then <em>say or type</em> what you want. Hold <kbd>space</kbd>{" "}
        to speak; drag to circle the thing you mean. Your intent lands in the session, and the agent
        edits this app's source while you watch it hot-reload.
      </p>
      <p>
        The rose below is placeholder scenery. Play with it — drag the sliders — then describe the
        app you actually want built here: <i>“turn this into a heart-rate dashboard”</i>,{" "}
        <i>“I want to explore protein structures”</i>, <i>“make me a tide chart for my harbor”</i>.
        Everything on this page, banner included, is meant to be rebuilt around your idea.
      </p>
    </header>
  );
}
