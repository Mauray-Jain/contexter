---
name: contexter
description: Work inside a shared contexter workspace, where several people each use their own Claude on one project (a paper, codebase, spec…) and contexter keeps everyone in sync. Use whenever the contexter tools are available or the user mentions their team, teammates, the shared workspace, the paper/sections/units, or what someone else did.
---

# Working in a contexter workspace

Several people collaborate on one project, each through their own Claude account. contexter
gives all of you one shared workspace (content, reasoning and a live team feed), so it should
feel like the whole team is in one conversation. You are one of those Claudes.

## Every reply

1. **Sync first.** In Claude chat, call `sync` before answering, every time, even for small
   questions, and pass `user_request` (the user's message in a sentence) so teammates see what
   you're working on. If the message starts with `!private`, still call `sync` but **leave out
   `user_request`**: teammates then only see that you're on something private. (In Claude Code a
   hook does this for you; you'll see a "team feed" block.)
   The result includes any new teammate activity in its "team feed" block.
2. **Use what you learn.** If teammates changed something relevant, say so naturally
   ("Since friend1 rewrote the method section an hour ago…"). Anything marked
   "← mentions you" was addressed to this user: bring it up first.
3. **Do the work through contexter** (below).
4. **Share the turn.** In Claude chat, end any reply that did real work with `post_turn`
   (the request in a sentence, and what you did in one or two). Claude Code's hooks post automatically.

If the user's message starts with `!private`, nothing about it is shared: call `sync` without
`user_request`, and don't call `post_turn` or `mention` for that turn.

## Never do the same work twice

The point of the workspace is that nobody redoes what a teammate already did or is doing.

- **"possible duplicate work"** means a teammate already asked for or did something like this
  request. Before starting, tell the user who did what and when. If it's the same work, build on
  theirs (read their files, `git log`, `read_unit`) instead of redoing it, or suggest a `mention`
  to coordinate. Carry on as normal only when it's clearly different.
- **"in progress right now"** lists what teammates' Claudes are doing at this moment. Don't start
  the same thing; point it out to the user.
- **"teammates on <file>"** appears before you edit a file a teammate is editing or recently
  changed. Their changes may be uncommitted on their machine: check `git status` / `git log` /
  `git pull` first, build on their version, and if they're editing it right now, check with the
  user before going ahead.

## Shared content

Content lives in **units** (`<collection>/<key>`, e.g. `sections/method`), listed by `get_overview`.

- Read before writing: `read_unit` gives the content, the current version and the linked reasoning.
- Write with `write_unit` and **always pass `expected_version`** (the version you read). If a
  teammate wrote in the meantime, the write is refused. Then `read_unit` again (or `diff_unit`),
  merge your change into their text, and write again. **Never discard a teammate's edit.**
- Give every write a one-line `summary` and, when the change isn't trivial, `reasoning`.
- For longer edits, `claim_unit` first and `release_unit` after. If a unit is locked by someone
  else, don't force it unless the user explicitly asks; suggest `mention`ing them instead.
- New pieces: `create_unit`. Workflow: `set_status` (e.g. drafting → review).
- Follow the workspace **rules** shown in the overview (citation style, voice, etc.).

## Shared reasoning

The team wants the *why* kept, not just the text. Use `record` for:

| type | when |
|---|---|
| `decision` | a choice was made (link the units it affects) |
| `rationale` | why a change was made (write_unit adds one automatically) |
| `alternative` | an option considered and rejected, and why |
| `finding` | a result, fact or piece of evidence |
| `question` | something open that someone needs to answer |

Use `why` to explain why something is the way it is before changing it, and `update_record` to
accept decisions, resolve questions or mark records superseded.

## Runs: long jobs the team should see

A **run** is a long job: a training run, a stress test on a shared machine, a benchmark, a sweep.
Everyone sees running jobs in the **"runs"** block before each message, with progress and how
long ago each one reported.

- When the user starts a long job, have it run under `contexter run -- <command>` (add
  `--title "…"` and `--watch <handles>`). That registers it, passes its output through, and reports
  progress, log tail and exit code by itself, with a heartbeat every minute.
- If it can't be wrapped, register it with `start_run` and call `update_run` when you learn how it
  went (status `succeeded` / `failed` / `cancelled`, `exit_code`, a one-line `progress`). In Claude
  Code, background commands are registered automatically; you'll be told the run number.
- `watch_run` makes teammates follow a run ("let Krish keep an eye on it"): they're told now and
  again when it ends. Pass `watchers` to `start_run` for the same thing up front.
- **Modal jobs:** `contexter run -- modal run --detach …` also records the Modal app id and
  profile name. If the machine that started it goes away (laptop closed, limit ran out), the job
  keeps running on Modal; hand it off and the recipient's machine watches it (progress, logs, how
  it ended). `contexter modal track <ap-…>` makes this machine watch a job started some other way.
  "NOBODY IS WATCHING" or "can't check it" on a Modal job needs the user's attention: suggest a
  handoff, or check that this machine has that Modal profile.
- **NO HEARTBEAT** on a `contexter run` job means the job or its machine probably died. Say so.
  Raise failed runs the user started or watches. `runs` with a `run` number gives the log tail.

## Handoffs: passing work on

When the user has to stop with work unfinished (for example their usage limit is about to run
out), offer to call `handoff`: `to` a teammate (or nobody, for anyone), a `title`, a `summary`
someone with none of this conversation can act on (goal, what's done, decisions, what's in
progress), `next_steps`, and the `files` involved. The teammate starts watching the user's running
jobs right away, and takes over their unit locks when they accept.

A **"handed to you"** block means a teammate handed work to this user. Bring it up first. If the
user wants it, `resolve_handoff` with `accept` and carry on from the next steps (check the files
and `git log` for the latest state); otherwise `decline`.

## Team memory

When contexter says the shared memory is behind, finish the user's request first, then call
`compact_memory` with a merged summary (previous summary + newer events: decisions, state of each
unit, open questions, who is doing what; under ~600 words) and the `covers_up_to` it gave you.

## Other tools

- `resume`: full catch-up for a fresh conversation (overview, memory and everything since).
- `team_feed`: browse history (by member or unit). `search`: full-text across everything.
- `mention`: leave a message for teammates; their Claude raises it on their next message.
- `list_workspaces` / `use_workspace`: if the user is in several workspaces.
