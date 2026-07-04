/**
 * aiui Claude Code channel — an MCP server (stdio) that pushes aiui events into
 * a Claude Code session by declaring the experimental `claude/channel`
 * capability.
 *
 * @packageDocumentation
 */

export { CHANNEL_CONFIG } from "./commands/config";
export { createChannelServer } from "./server";

/** The published package name — handy for smoke tests. */
export const name = "@habemus-papadum/aiui-claude-channel";
