/**
 * map.worker.ts — the thin protocol seam (playbook rule: choreography only,
 * math in layer 1). Speaks the aiui-viz worker-stream framing; the actual
 * field computation is @habemus-papadum/aiui-optics's runMapRequest, which
 * yields a macrotask between chunks so "cancel" messages get delivered.
 */
import type { MapReplyChunk, MapRequest } from "@habemus-papadum/aiui-optics";
import { runMapRequest } from "@habemus-papadum/aiui-optics";
import type { WorkerReply, WorkerRequest } from "@habemus-papadum/aiui-viz";

const cancelled = new Set<number>();

self.onmessage = (event: MessageEvent<WorkerRequest<MapRequest>>) => {
  const msg = event.data;
  if (msg.type === "cancel") {
    cancelled.add(msg.id);
    return;
  }
  const { id, payload } = msg;
  void runMapRequest(payload, {
    isCancelled: () => cancelled.has(id),
    post: (reply, transfer) => {
      const framed: WorkerReply<MapReplyChunk> =
        reply.type === "error" ? { id, type: "error", message: reply.message } : { id, ...reply };
      (self as unknown as Worker).postMessage(framed, transfer ?? []);
    },
  }).finally(() => cancelled.delete(id));
};
