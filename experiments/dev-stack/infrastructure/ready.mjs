/** One structured line, after binding and initialization; ordinary logs can coexist. */
export function reportReady(url) {
  console.log(JSON.stringify({ type: "dev-ready", url }));
}
