/**
 * tools.ts — the backends bench's toy tools: a clock, an adder, and a slow
 * lookup whose duration the user chooses. Plain TypeScript, shared by the
 * page and the headless script, so a backend's behaviour can be compared
 * with and without a browser in the loop.
 */

import type { LiveTool } from "@habemus-papadum/aiui-live";

export function benchTools(): LiveTool[] {
  return [
    {
      name: "clock",
      description: "The current local time and date.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: () => ({ now: new Date().toString() }),
    },
    {
      name: "add",
      description: "Add two numbers exactly.",
      parameters: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
        additionalProperties: false,
      },
      execute: (args) => ({ sum: Number(args.a) + Number(args.b) }),
    },
    {
      name: "slow_lookup",
      description:
        "Look a term up in a slow archive. Takes `seconds` to answer (default 8). Returns a short fact.",
      parameters: {
        type: "object",
        properties: {
          term: { type: "string" },
          seconds: { type: "number", minimum: 0, maximum: 120 },
        },
        required: ["term"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const seconds = typeof args.seconds === "number" ? args.seconds : 8;
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        return {
          term: args.term,
          fact: `The archive says "${String(args.term)}" was filed under D, after ${seconds} seconds of searching.`,
        };
      },
    },
  ];
}
