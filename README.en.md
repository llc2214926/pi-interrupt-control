# pi-interrupt-control

[简体中文](README.md) | **English**

A Pi extension to continue tasks with a dot, hand unfinished work to a new session with `/new-continue`, and retry failed model requests before handing control back to Pi.

## Features

- Send `.` or `。` alone to continue the most recent unfinished task.
- `/new-continue` generates a handoff and automatically continues in a new session. Empty sessions fall back to history in the same workspace.
- Each main model request gets **3 extra retries**, **3 seconds** apart by default.
- `/set-retry` changes the current session's retry count and interval. A negative count stops the run after exhaustion.
- Only the latest retry notice is shown. It is cleared afterward, leaving one retry summary; manual cancellation leaves no summary.
- No extra retries for other sessions, compaction, summarization, or cache warming.

## Installation

Requires **Pi 1.5.0 or newer** and Node.js 22.19.0 or newer. No build is needed. Pi 1.4.x and earlier are unsupported for all features.

### From GitHub

```sh
pi install git:github.com/llc2214926/pi-interrupt-control
```

### From a local checkout

```sh
pi install /absolute/path/pi-interrupt-control
```

Restart Pi after installation, or run `/reload` in an existing session.

To try it for one invocation without loading other extensions:

```sh
pi --no-extensions --extension /absolute/path/pi-interrupt-control/src/index.ts
```

## Usage

### Continue the current task

Send this on its own:

```text
。
```

An ASCII dot (`.`) also works; surrounding whitespace is ignored. The extension sends a hidden continuation instruction. It starts a turn when idle or queues a follow-up when busy, without interrupting current work. The instruction still enters model context; hidden does not mean unrecorded.

Input containing other text, multiple dots, or images is unchanged. Messages injected by other extensions are not converted.

### Continue in a new session

```text
/new-continue
```

The former `/s-new-continue` command from `pi-session-manager` has moved here as `/new-continue`. The old command is no longer registered. Installing `pi-session-manager` is not required.

- Takes no arguments. Requires Pi's interactive terminal (TUI), a working model, and credentials. Wait for the current task and message queue to finish, or press Esc to stop first. While busy, the command shows a notice rather than forcibly interrupting work.
- Uses the active branch's effective history, including compaction summaries and context edits, without mixing in other branches. Sessions containing only system prompts, model settings, or extension state count as empty.
- For an empty session, first follow its same-workspace parent. If no usable parent is available, search backward by creation time in the current session directory. Skip empty, missing, or damaged records and avoid cycles. Do not read archives or continue tasks from another workspace. No usable history means no new session.
- The current model generates a Chinese handoff covering goals, constraints, decisions, completed work and evidence, pending tasks, blockers, and next steps. Press Esc during generation to cancel. No session is created if the model explicitly reports no unfinished work.
- The original session is kept. The new session saves the handoff, source, and summary usage before automatically continuing. If automatic submission fails, send “继续” manually. The handoff does not replace the new session's system prompt or grant extra permissions.

**Cost and privacy:** This makes a summarization request and subsequent model requests. User messages, file snippets, and tool output in effective history are sent as text to the current model provider. Excluding original system messages is not a redaction guarantee. Ensure the provider is appropriate for that data.

**Limits:** Summaries may omit details, and images are not fully transferred; consult the original session when needed. Model context limits apply. Failed, incomplete, or empty summaries do not switch sessions or silently truncate history. Historical session files that are symlinks, exceed 256 MiB, or use an unsupported format are rejected.

### Configure retries

```text
/set-retry          Show current settings
/set-retry 10 5s    Retry 10 extra times, 5 seconds apart, then hand control to Pi
/set-retry -3 2s    Retry 3 extra times, 2 seconds apart, then stop
/set-retry 0        Disable this extension's extra retries
/set-retry 3        Restore the default count and 3-second interval
```

- The count must be an integer from `-100` to `100`, specifying retries **after the initial attempt**.
- The interval uses a lowercase `s`, accepts decimals such as `0.5s`, and ranges from `0.001s` to `2147483.647s`. Omitting it resets the interval to `3s`.
- Invalid arguments leave existing settings unchanged.
- Settings live only in the current extension runtime's session memory. Reloading extensions, restarting Pi, or creating a new session restores defaults. No global configuration is written.

## Compatibility and limitations

- Priority retries require Pi's `ModelRegistry.runtime.streamSimple`. A missing interface produces an explicit error and prevents priority retries; dot continuation still works.
- To prevent execution of partial tool calls from failed responses, a reply is displayed only after a request completes, rather than streamed token by token.
- Exhausting a nonnegative count may still trigger Pi's own retries, compaction, or another fallback extension. `/set-retry 0` does not disable them. Exhausting a negative count aborts the current run without initiating a provider switch.
- All model request errors are retried first, including authentication and context-limit errors. Larger counts and intervals increase waiting time and may incur extra costs.
- Manual cancellation stops retries. This extension never switches models or providers itself.

## License

MIT. See [LICENSE](LICENSE).
