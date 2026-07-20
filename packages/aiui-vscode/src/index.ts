/**
 * aiui-vscode — a VS Code selection provider for aiui sessions.
 *
 * The extension itself (extension.ts, bundled into the .vsix by
 * build-extension.mjs) is host glue over this library: discovery of running
 * channel servers via their on-disk registry (channels.ts), and the pure
 * builder for the structured `SelectionContribution` published to the
 * session bus (contribution.ts). The npm artifact ships the library only — useful for any
 * other editor tool that wants to contribute selections to a session.
 *
 * @packageDocumentation
 */

export * from "./channels";
export * from "./contribution";
