/** Nav.tsx — the pages, in the order they are meant to be read: the tour
 * first (a mental model, no API calls), then the three live pages. */

export function Nav(props: { current: "tour" | "wire" | "backends" | "app" }) {
  const pages = [
    { id: "tour", href: "/tour.html", label: "0 · tour" },
    { id: "wire", href: "/wire.html", label: "1 · wire" },
    { id: "backends", href: "/backends.html", label: "2 · backends" },
    { id: "app", href: "/", label: "3 · the app" },
  ] as const;
  return (
    <nav class="site-nav">
      {pages.map((page) => (
        <a href={page.href} data-on={String(page.id === props.current)}>
          {page.label}
        </a>
      ))}
      <span class="site-nav-tag">aiui · live</span>
    </nav>
  );
}
