/**
 * session-name.ts — the human-visible session name a panel announces on the
 * remote wires (/pencil and /bar), so an iPad picking among several connected
 * panels sees "courageous-beaver", not two identical rows.
 *
 * The name is a display identity, not an id: uniqueness is not required (the
 * relay's `host-N` id stays the join key), but the generator's space is large
 * enough that two panels colliding is rare. A name persists per
 * (channel, panel window): reconnecting to a channel you have used before
 * reuses it; a genuinely new pairing mints a fresh one; the user can rename it
 * from the panel any time. The store is an injected seam because the two tiers
 * persist differently — `chrome.storage.local` in the extension (the `aiui2.*`
 * convention), `localStorage` on the plain page.
 */

const ADJECTIVES = [
  "amber",
  "bold",
  "brave",
  "breezy",
  "bright",
  "calm",
  "candid",
  "cheerful",
  "clever",
  "cosmic",
  "courageous",
  "cozy",
  "crisp",
  "curious",
  "dapper",
  "deft",
  "eager",
  "earnest",
  "fearless",
  "fleet",
  "gentle",
  "golden",
  "hearty",
  "humble",
  "jolly",
  "keen",
  "lively",
  "lucky",
  "mellow",
  "merry",
  "nimble",
  "noble",
  "patient",
  "plucky",
  "proud",
  "quiet",
  "rosy",
  "solemn",
  "spry",
  "steady",
  "sunny",
  "swift",
  "valiant",
  "vivid",
  "wandering",
  "witty",
  "zesty",
  "zippy",
] as const;

const ANIMALS = [
  "badger",
  "beaver",
  "bison",
  "bobcat",
  "condor",
  "coyote",
  "crane",
  "dolphin",
  "falcon",
  "ferret",
  "finch",
  "fox",
  "gazelle",
  "gecko",
  "gibbon",
  "hedgehog",
  "heron",
  "ibex",
  "jaguar",
  "kestrel",
  "koala",
  "lemur",
  "lynx",
  "magpie",
  "manatee",
  "marmot",
  "meerkat",
  "moose",
  "narwhal",
  "ocelot",
  "orca",
  "osprey",
  "otter",
  "owl",
  "panda",
  "pelican",
  "penguin",
  "puffin",
  "quokka",
  "raven",
  "seal",
  "sparrow",
  "tapir",
  "toucan",
  "walrus",
  "wombat",
  "wren",
  "yak",
] as const;

/** "courageous-beaver" — adjective-animal, from an injectable random source. */
export function generateSessionName(random: () => number = Math.random): string {
  const pick = <T>(list: readonly T[]): T => {
    const index = Math.min(list.length - 1, Math.floor(random() * list.length));
    return list[Math.max(0, index)];
  };
  return `${pick(ADJECTIVES)}-${pick(ANIMALS)}`;
}

/** Where a tier persists names — async because chrome.storage is. */
export interface NameStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

const KEY_PREFIX = "aiui2.sessionName:";

/**
 * The storage key for one (channel, window) pairing. `scope` is the channel's
 * stable identity — its project directory when the registry mirror answers,
 * else a `port:<n>` fallback. `window` is the extension tier's windowId (the
 * plain page has none); windowIds do not survive a browser restart, so a
 * restart mints fresh names there (accepted — the name is display identity,
 * not a durable handle).
 */
export function sessionNameKey(scope: string, window?: number): string {
  return `${KEY_PREFIX}${window ?? "page"}:${scope}`;
}

/** The stored name for the key, or a freshly generated-and-stored one. */
export async function loadOrCreateSessionName(
  store: NameStore,
  key: string,
  random: () => number = Math.random,
): Promise<string> {
  const stored = await store.get(key);
  if (stored !== undefined && stored.trim() !== "") {
    return stored;
  }
  const name = generateSessionName(random);
  await store.set(key, name);
  return name;
}
