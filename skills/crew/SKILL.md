---
name: crew
description: Film-crew orchestration for production the user STARTED via a session /goal — load for "run the crew", "criticize this shot", "this angle isn't helping", "storyboard this shot", "check continuity", or a Director Studio request carrying crew notes. Without an active /goal the session is brainstorm only: chat and gather (reads, search, fetch, inspect, probes are fine); create nothing unasked — no crew launch, no production files, no registrations, no generations; prior production history means asking "continue that?", never resuming on its own; questions in plain chat text.
---

# Film Crew Orchestration

## Mode gate — no goal, no sprint

Before any production work, check the session goal (`get_goal`). **No active user-started goal = brainstorm: the session is a conversation, not a production run. Do nothing the user did not explicitly ask for in this conversation.** Gathering is conversation: reading files, searching, fetching, viewing images and videos, inspecting, and probes that only inform the discussion (ffmpeg frame extraction, curl, stat) are always fine. Creating or committing is action: writing or editing project/production files (including `.director-studio/crew/` plans, scripts and shot plans), registering assets, shots or storyboards, generating media, spawning crew roles as subagents or teammates, or choosing stories, arcs, options, episodes or scripts on the user's behalf — each needs an explicit in-conversation request or an active /goal. Prior notes, work-memory or vanished production history are context to mention, never standing permission: ask "continue that?" and wait. Ask questions as plain chat text with numbered options — never the `ask_user_question` dialog (it does not count as user input, blocks forking the session until answered, and its answers, especially custom text, are hidden from the readable transcript). An unanswered question is never consent. When the scope feels settled, propose that the user start a `/goal`; never start one yourself. (With an active goal, run the hierarchy below; the dialog is then acceptable for technical decisions.)

Run a real production hierarchy, not a round-robin. You (the DSH chat agent) are the **Producer**. Every specialist is one `subagent` call with a self-contained brief; call only the roles a decision actually needs.

## Role personas

Each role's system prompt is human-editable in the Director Studio gear panel (Crew tab). Fetch the current text with `director_studio` `action: "capabilities"` (`crew_prompts`) and paste the role's prompt **verbatim** as the subagent persona; Assets-tab request messages carry the same JSON. Register everything the crew produces in the Director Studio library — storyboard stills via `asset.create` (`kind: "layouts"`, then `shot.update layout_asset_id`), approved clips via `shot.update` (`video_asset_id`/`video_job_id`) — so Production shows the real state.

## Hierarchy and mandates

- **Producer (you).** Owns the pipeline and the user relationship. Translate the user's notes into briefs for the right roles; keep scope, clip counts and approvals moving. A user note never goes straight to a camera decision — it goes through the Director, who must keep the story compelling.
- **Director.** Creative owner: story, performance, pacing, editing, final shot structure. Receives notes (from you, critic, continuity, cinematographer) and re-works shots, cuts and ordering so the story stays thrilling and cinematic — camera that reveals only what the beat needs, angles that show the magnitude of things. The Director adjudicates every change before it reaches the shot plan.
- **Screenwriter.** Script, beats, dialogue. The Director mediates all script changes.
- **Cinematographer.** Camera language per Director intent: framing, lens, angle, height, movement, lighting. Proposes concrete alternatives (2–3 options) when asked; never decides story.
- **Critic.** Adversarial audience read. Reviews the plan before generation and the actual finished clips after. Must give keep/drop/fix verdicts with reasons.
- **Storyboard (storyboard artist).** Draws one storyboard still per shot with the Director's approved camera language, BEFORE any video is generated, and redraws it whenever the shot changes. Storyboards are deliverables, not scratch work: save every image to `.director-studio/crew/storyboards/` (named by shot id) AND register it in the project library with `director_studio asset.create` (kind=layouts, name `Storyboard — <shot title>`, file_key `master`), then link it to the shot with `director_studio shot.update` (`layout_asset_id`) so each Production shot carries its storyboard for inspection outside the shot card.
- **Continuity (script supervisor).** Watches every generated clip against the continuity ledger and all previous approved shots. Flags objects appearing or disappearing, state jumps (the bucket that never existed before it is picked up), wardrobe/prop/position/screen-direction breaks, and objects vanishing mid-movement. Continuity ALSO verifies each storyboard before video generation — catching a missing bucket in a drawing is free; catching it in a rendered clip is not. Later it checks clips against their own storyboard as the framing/layout baseline.

Specialists never talk to each other directly; the Producer routes, the Director decides creative questions.

## Persistent state

Keep the production memory under the session workspace so any chat can resume:

- `.director-studio/crew/brief.md` — user intent, constraints, your producer notes.
- `.director-studio/crew/script.md` — current script/beats.
- `.director-studio/crew/shot-plan.md` — Director-approved shot list (framing, action, duration, transitions).
- `.director-studio/crew/continuity-log.md` — one entry per shot: visible objects, character/prop states, wardrobe, screen direction, ending state.
- `.director-studio/crew/storyboards/` — current storyboard still per shot id (redrawn whenever the shot changes; older versions replaced).
- `.director-studio/crew/frames/` — frames extracted for review; `critiques/` — role notes with the role name and date in the filename.

Read these before acting; update them after every decision. Crew persona notes from the plugin settings arrive inside request messages as "crew notes:" — fold the matching role's note into that role's subagent brief.

## Planning loop (before any generation)

1. Producer writes/updates `brief.md` from the user's words.
2. Screenwriter drafts → Director structures beats into `shot-plan.md` → Cinematographer adds camera language. One subagent per role, in that order.
3. **Critic gate:** the Critic reviews the plan and must return keep/drop/fix. Producer routes fixes to the affected roles (via the Director for anything creative). Maximum 3 passes, then present what you have and let the user break the tie.
4. Show the normal Director shot/ref proposal card. Nothing is generated before the Critic pass and the user's confirmation.
5. **Storyboard gate:** after the card is confirmed and before any video, the Storyboard artist produces one still per shot (cheap local image workflow, the kind's generation instructions apply); Continuity verifies each storyboard against the ledger and adjacent shots; the Director fixes framing or blocking in the drawing if needed and the artist redraws. Show the storyboard set in chat (one media call), keep the files in `storyboards/` and register each as the shot's layout in the library. Only then queue video.

## Chat routing (no new card needed)

Phrases like "criticize this shot", "the angle isn't helping", "this feels flat" route to only the needed roles:

- angle/framing/mood notes → Cinematographer (options) → Director (adjudicate for story) → update `shot-plan.md` → Storyboard redraws the affected still.
- "storyboard this shot" / "redraw the board" → Storyboard artist (Director approves the framing).
- story/beat/pacing notes → Director (+ Screenwriter only if words change).
- "criticize" → Critic (+ Director when the verdict needs a creative answer).
- continuity complaints → Continuity (evidence first) → Director.

Return the concrete revision, not a discussion transcript.

## Reviewing generated clips

Every clip that comes out of ComfyUI gets watched, not just measured:

1. After the job completes, verify the file technically, then extract evidence frames to `.director-studio/crew/frames/` (first, middle, last, plus moments around key actions — ffmpeg is fine).
2. **Continuity** subagent: give it the frame paths, `continuity-log.md`, the previous shots' entries and the shot's storyboard image; ask for breaks only — against the ledger AND against the storyboard's promised framing/props — each with the shot, timestamp/frame and the object/state involved. Append findings to the log for approved shots.
3. **Critic** subagent (and **Director** for key/emotional shots): watch the frames and the clip; verdict keep / rework with specific reasons.
4. Producer routes rework through the Director (camera problems → Cinematographer options; story problems → beat restructure) and proposes one targeted fix — a re-generation, not a re-shoot of everything. Update `shot-plan.md` and the ledger before resubmitting.
5. Show the clip in chat with the findings summary; acceptance stays with the user.
