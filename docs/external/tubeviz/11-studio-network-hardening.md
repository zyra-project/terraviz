# Studio: default to loopback, add an access token, and warn on `--host 0.0.0.0`

> **Not for filing.** tubeviz is upstream and unaffiliated; nothing here is to be opened as an issue on that repository. Kept as the analysis record behind [`docs/TOUR_DIRECTION_PLAN.md`](../../TOUR_DIRECTION_PLAN.md). See that document's §3 for why none of this code may be imported.

**Labels:** `security`, `studio`

## Summary

Studio is an unauthenticated web app that starts subprocesses and deletes files.
That is fine on loopback and dangerous anywhere else — but the README documents
binding it to all interfaces with no warning attached.

## Background — accurate scope

To be precise about what this is and isn't:

**Not a command-injection bug.** Jobs are built as an argv list with an
allowlist of flags and no shell:

- [`gui.py#L145`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/gui.py#L145)
  — `_tubeviz_command` → `[sys.executable, "-m", "tubeviz.cli", *parts]`
- [`gui.py#L159`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/gui.py#L159)
  — `_job_command` maps a typed `JobRequest` onto named flags via
  [`_flag`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/gui.py#L149)
- [`gui.py#L97`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/gui.py#L97)
  — `subprocess.Popen(...)` with a list, no `shell=True`

Media serving is also handled correctly — `StaticFiles` resolves beneath a root
and rejects traversal, with a comment saying so:
[`server.py#L103-L114`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/server.py#L103-L114).

**What is exposed** is that any client that can reach the port can, with no
credential:

- start arbitrary render/ingest/analyze jobs — `POST /api/gui/jobs`
  ([`gui.py#L456`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/gui.py#L456));
- choose caller-controlled paths for `library`, `audio` and `output`
  ([`gui.py#L159`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/gui.py#L159)),
  i.e. read and write anywhere the process can;
- delete library media — `POST /api/gui/clip/{source_id}/delete`
  ([`gui.py#L442`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/gui.py#L442)).

And the [README](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/README.md)
lists, without qualification:

```bash
tubeviz gui --host 0.0.0.0 --port 8090
```

On a laptop at a venue, a conference, or a shared studio LAN, that is a remote
job-runner and file-deleter for anyone on the network. The default
(`127.0.0.1`) is already right — the docs just hand people the loaded footgun
with no safety note.

## Proposal

Small, non-breaking, keeps the tool as convenient as it is today:

1. **Warn loudly on a non-loopback bind.** When `--host` isn't a loopback
   address, print a startup banner: what is being exposed, and how to add a token.
2. **Optional shared-secret token.** `--token <value>` (or a generated one
   printed at startup, appended to the URL that gets opened). Enforced by a
   FastAPI dependency on `/api/gui/**` — a few lines in
   [`create_gui_app`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/gui.py#L278).
   **Require** it when the bind is non-loopback; optional on loopback so the
   default local workflow is untouched.
3. **Constrain job paths to the project root.** `create_gui_app` already resolves
   a `project_root`
   ([`gui.py#L283`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/gui.py#L283))
   — reject `library` / `audio` / `output` paths that resolve outside it, with
   `--allow-external-paths` to opt out.
4. **Document it.** One short "Running Studio on a network" note in the README,
   next to the `--host 0.0.0.0` example.

## Acceptance criteria

- [ ] Loopback default behaviour is byte-for-byte unchanged with no new flags.
- [ ] A non-loopback bind without `--token` refuses to start, or starts with a
      prominent warning (maintainer's call on which).
- [ ] With a token set, unauthenticated `/api/gui/**` requests get `401`.
- [ ] Job paths outside the project root are rejected unless explicitly allowed.
- [ ] README documents the network case.
