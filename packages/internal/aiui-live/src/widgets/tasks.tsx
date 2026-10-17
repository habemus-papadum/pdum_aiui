/**
 * tasks.tsx — the task table: every delegation, its status, and the three
 * timings the wire never states — created → first append, append → first
 * spoken word, created → done — plus the appends and the backend's log
 * lines under a fold. This is where "how long does thinking take" is read.
 */

import { createEffect, createSignal, For, Show } from "solid-js";
import type { LiveSession } from "../session";
import { type LiveTask, taskTimings } from "../types";
import { ms, stamp, useLiveState } from "./state";

export interface LiveTasksProps {
  session: LiveSession;
  /** Newest first (default true). */
  newestFirst?: boolean;
}

export function LiveTasks(props: LiveTasksProps) {
  const state = useLiveState(props.session);
  const rows = () => {
    const tasks = state().tasks;
    return props.newestFirst === false ? tasks : [...tasks].reverse();
  };
  // The id list only changes when a task appears or the order changes; the
  // same reference is kept otherwise so the For never re-keys on a status bump.
  const [ids, setIds] = createSignal<string[]>([]);
  createEffect(
    () => rows().map((task) => task.id),
    (next) => {
      setIds((prev) =>
        prev.length === next.length && prev.every((id, i) => id === next[i]) ? prev : next,
      );
    },
  );
  return (
    <div class="aiui-live-tasks">
      <Show when={rows().length === 0}>
        <div class="aiui-live-empty">
          no delegations yet — say something the prompt says to delegate
        </div>
      </Show>
      {/* Rows are keyed by task ID (stable), and each row reads the CURRENT
          snapshot through an accessor: snapshots are by value, so an
          in-place status change re-renders the row's fields without
          recreating the row (and its fold state). */}
      <For each={ids()}>
        {(id) => (
          <TaskRow
            task={() => rows().find((task) => task.id === id) ?? EMPTY_TASK}
            session={props.session}
          />
        )}
      </For>
    </div>
  );
}

const EMPTY_TASK: LiveTask = {
  id: "",
  seq: 0,
  target: "local",
  createdAt: 0,
  status: "open",
  request: "",
  appends: [],
  log: [],
};

function TaskRow(props: { task: () => LiveTask; session: LiveSession }) {
  const [open, setOpen] = createSignal(false);
  const task = () => props.task();
  const timings = () => taskTimings(task());
  return (
    <div class="aiui-live-task" data-status={task().status} data-open={String(open())}>
      <div class="aiui-live-task-head">
        <button type="button" class="aiui-live-task-summary" onClick={() => setOpen(!open())}>
          <span class="aiui-live-task-id" title={task().id}>
            #{task().seq} {task().target}
          </span>
          <span class="aiui-live-task-status">{task().status}</span>
          <span class="aiui-live-task-request">{task().request || "(no transcript yet)"}</span>
          <span class="aiui-live-task-timing" title="created → first append">
            ↦ {ms(timings().toFirstAppendMs)}
          </span>
          <span class="aiui-live-task-timing" title="first append → first spoken word">
            🔊 {ms(timings().appendToSpokenMs)}
          </span>
          <span class="aiui-live-task-timing" title="created → done">
            ∑ {ms(timings().totalMs)}
          </span>
        </button>
        <Show when={task().status === "open"}>
          <button
            type="button"
            class="aiui-live-task-cancel"
            onClick={() => props.session.cancelTask(task().id)}
          >
            cancel
          </button>
        </Show>
      </div>
      <Show when={open()}>
        <div class="aiui-live-task-detail">
          <div class="aiui-live-task-meta">
            created {stamp(task().createdAt)}
            {task().offsetMs !== undefined ? ` · offset ${task().offsetMs} ms` : ""}
            {task().backend !== undefined ? ` · backend ${task().backend}` : ""}
            {task().error !== undefined ? ` · ${task().error}` : ""}
          </div>
          <For each={task().appends}>
            {(append) => (
              <div
                class="aiui-live-task-append"
                data-kind={append.kind}
                data-error={String(append.error !== undefined)}
              >
                <span class="aiui-live-task-t">{stamp(append.t)}</span>
                <span class="aiui-live-task-kind">{append.kind}</span>
                <span class="aiui-live-task-text">{append.content}</span>
                <span class="aiui-live-task-ack">
                  {append.error ??
                    (append.ackT === undefined
                      ? "…"
                      : `ack +${Math.round(append.ackT - append.t)} ms`)}
                </span>
              </div>
            )}
          </For>
          <For each={task().log}>
            {(line) => (
              <div class="aiui-live-task-log">
                <span class="aiui-live-task-t">{stamp(line.t)}</span>
                <span class="aiui-live-task-text">{line.line}</span>
              </div>
            )}
          </For>
          <Show when={task().result}>
            {(result) => <div class="aiui-live-task-result">result: {result()}</div>}
          </Show>
        </div>
      </Show>
    </div>
  );
}
