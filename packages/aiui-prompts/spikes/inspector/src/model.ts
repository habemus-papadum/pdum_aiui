/** Disposable fixture schema. These are NOT the future prompt package's public types. */
export interface SourceSite {
  file: string;
  startLine: number;
  endLine: number;
}

export interface Occurrence {
  id: string;
  definition: string;
  label: string;
  parent?: string;
  source: SourceSite;
  origin?: string;
}

export interface Contribution {
  owner: string;
  start: number;
  end: number;
}

export interface TextPart {
  kind: "text";
  id: string;
  text: string;
  contributions: Contribution[];
}

export interface ImagePart {
  kind: "image";
  id: string;
  owner: string;
  asset: { id: string; revision: string; alt: string; uri: string; width: number; height: number };
}

export type Part = TextPart | ImagePart;
export interface Artifact {
  id: string;
  revision: string;
  occurrences: Occurrence[];
  sources: Record<string, string>;
  parts: Part[];
  instructions: string;
  history: { kind: "conversation"; id: string } | { kind: "none" };
}

export interface Fixture {
  id: string;
  title: string;
  note: string;
  before: Artifact;
  after: Artifact;
}

/** Offsets are derived during literal assembly, never by searching rendered text. */
export function textPart(id: string, pieces: ReadonlyArray<readonly [string, string]>): TextPart {
  let text = "";
  const contributions = pieces.map(([owner, value]) => {
    const start = text.length;
    text += value;
    return { owner, start, end: text.length };
  });
  return { kind: "text", id, text, contributions };
}

export function ancestors(artifact: Artifact, id: string): string[] {
  const result: string[] = [];
  let occurrence = artifact.occurrences.find((item) => item.id === id);
  while (occurrence) {
    result.push(occurrence.id);
    occurrence = artifact.occurrences.find((item) => item.id === occurrence?.parent);
  }
  return result;
}

export function ownersIn(part: TextPart, start: number, end: number): string[] {
  return [
    ...new Set(
      part.contributions.filter((c) => c.start < end && c.end > start).map((c) => c.owner),
    ),
  ];
}

/** Fixture request: provider-neutral, deliberately not an SDK request or a sent snapshot. */
export function request(artifact: Artifact) {
  return {
    status: "fixture-only",
    history: artifact.history,
    currentTurn: {
      instructions: artifact.instructions,
      messages: [
        {
          role: "user",
          content: artifact.parts.map((part) =>
            part.kind === "text"
              ? { type: "text", text: part.text }
              : {
                  type: "image",
                  asset: part.asset.id,
                  revision: part.asset.revision,
                  mimeType: "image/svg+xml",
                },
          ),
        },
      ],
    },
  };
}

export function measure(artifact: Artifact, hidden: (owner: string) => boolean) {
  let totalText = 0;
  let hiddenText = 0;
  let totalImages = 0;
  let hiddenImages = 0;
  for (const part of artifact.parts) {
    if (part.kind === "image") {
      totalImages++;
      if (hidden(part.owner)) hiddenImages++;
    } else {
      totalText += part.text.length;
      // Contributions partition the part; nested folds cannot double-count the same range.
      hiddenText += part.contributions.reduce(
        (sum, c) => sum + (hidden(c.owner) ? c.end - c.start : 0),
        0,
      );
    }
  }
  return { totalText, hiddenText, totalImages, hiddenImages };
}
