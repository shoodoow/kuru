Tool descriptions the model sees, one section per tool (`# tool_name`). A `# tool_name.worker` section, when present, replaces the description for background workers. Names, surfaces and input schemas live in `packages/agent-tools/src/definitions.ts`; this file is the only place the wording lives. Loaded by `apps/core/src/turn/tools/build-tools.ts`.

# send_message
Send a bubble to the person now, before your turn is over. Use it for a short ack before slower work, and for rich blocks: `image` (url), `code`, `file` (url + name; the url can be the file's path on your computer, in your home or `/shared`, and the file itself is delivered), and `widget`. Your final plain text is already shown as your reply, so a plain answer needs no call.
Each block is a typed object, for example `{ "kind": "text", "markdown": "On it." }` or `{ "kind": "widget", "widget": "question", "props": { "prompt": "...", "options": [{ "label": "..." }] } }`.
Widgets: `question` (one decision, 1-6 short options you have verified), `poll` (multi-select), `checklist`, `table`, `chart` (see below), `approval`, `agent-card`, `secret` (props.envName required; the only way to ask for a password, token or key), `desktop-handover` (props.message says what to do on your computer; for a login, 2FA or payment step only they can do). `secret` and `desktop-handover` end the turn.

A `chart` widget draws numbers the person should see at a glance; use it instead of a table when the shape of the data is the point. Props: `type` is `bar` (compare categories), `line` (a trend over time) or `pie` (shares of a whole, at most about six slices); `title`; `labels`, one per point; and `values`, the numbers in the same order. To compare several sets on one bar or line chart, give `series` in place of `values`: `[{ "name": "2025", "values": [...] }, { "name": "2026", "values": [...] }]`. Add `unit` (such as `$` or `%`) when the numbers have one. Example: `{ "kind": "widget", "widget": "chart", "props": { "type": "line", "title": "Followers", "labels": ["Jan", "Feb", "Mar"], "values": [1200, 1850, 2600] } }`. Say what the chart shows in a line of text beside it.

# react_to_message
Add one emoji tapback to a message when a reaction is the whole reply. Rare.

# notify_user
Ping the person when you are blocked on them or something is urgent. Not for routine progress.

# spawn_worker
Start a background worker for anything you cannot do with a few quick lookups: shell commands and installs, writing or building files, rendering, a live or login-gated web page, the desktop, or research across several sources. It returns at once and your turn ends; the finished report is delivered to you on its own.
The worker sees only `task`, plus the person's recent messages, which are attached for you. Write the brief as the problem and the outcome: what to produce, every requirement the person gave (size, length, style, things to leave out), the exact URLs or paths you know, what done looks like, and what to report back. Leave the method to the worker: no step-by-step commands, no version numbers you are not sure of, no diagnosis you have not verified. The worker keeps going until the job is finished and checks its own result, so give it the whole job in one brief.
A new job that follows on from work just done in this chat is given to the worker that did it, which still knows the files and what was tried; the result says `continued` when that happened.
`kind`: `executor` general work (default) · `shell` commands and installs · `explore` find and read files · `browser` live web pages that need clicking or reading · `computer` desktop GUI apps · `docs` read public documentation · `debug` evidence-based debugging · `vm_setup` set up a project · `watch_video` / `video_review` media.
`skills`: a list of skill names the worker should follow, for example `["docx"]`. Their full text is loaded for it, so you do not read them first.

# stop_worker
Stop a worker that is wedged, wrong, or no longer needed, by its worker id. What it did is kept, so `redirect_worker` can continue it later.

# redirect_worker
Talk to one of your workers by its id. It keeps everything it has read, built and learned, so say only what is new.
If it is running, it reads your note before its next step and carries on: use this when the person changes direction, adds a requirement, or the worker is drifting.
If it has finished or stopped, it starts again from where it left off with your note as its instruction: use this to fix something in its result, finish what it left undone, or try again. This is the right tool for any follow-up on the same job.

# check_worker
Look at your workers: which are running right now, for how long, the last things each one did, and the result of the ones that finished. Pass `workerId` for one worker or nothing for all of them in this chat. Call it before you tell the person that something is still in progress, and whenever a worker has been quiet for a long time. It only looks; results still arrive on their own.

# open_on_screen
Open a web page in the browser on your own desktop, where the person can watch and take over. It starts the desktop and the browser if they are not running, goes to the URL, and tells you whether the window is really on screen. Use it for "open X" and "open X and hand it over"; follow it with a `desktop-handover` widget.

# enable_tools
Turn on an extra tool set for the rest of this turn. `team`: create groups, hire lasting teammates, delegate to them. `routines`: schedule, change or delete your recurring jobs. `admin`: list or rescan skills, read your saved worklist. The result explains how to use the set.


# read_skill
See what one skill is for, by name. You get its opening section, enough to decide whether it fits and to brief a worker. The full procedure is loaded for a worker when you pass the name in `spawn_worker.skills`.

# read_skill.worker
Load one skill's full steps by name when the task needs that procedure and it was not already given to you.

# list_skills
List the skills you can load, with descriptions. Skills are shared across the account: one installed by any agent is available to all of them.

# refresh_skills
Rescan skills after an install so the next turn's skill list includes the new ones.

# read_history
Read one earlier message in full by its id (ids appear as `[msg:<id>]` in your memory lines and in `search_memory` results), or search this room's older messages for a few words (up to 5 hits).

# search_memory
Search everything you know across all your rooms and all time: saved facts, summaries of past conversations, and old messages. Use it when the answer may lie further back than the messages in front of you ("what did we decide about X?", "who is Y?"). Give a few key words, and optionally `from` / `to` dates as YYYY-MM-DD. Returns dated lines with ids you can open with `read_history`.

# read_history.worker
Read one cited message by id, or search a short slice of the room (up to 5 hits), when the task depends on something said there.

# remember_fact
Save one durable fact: a preference, a decision, a person or organization and their role, or a standing rule. `scope: "agent"` when only you should keep it. `scope: "user"` when every agent on this account should. You do not send an agent id. Not for secrets, guesses, or passing status.

# correct_memory
Replace one saved fact when the person corrects it. Give the old text exactly as it appears in your memory, the replacement, and the same scope it was saved under: `"agent"` for a fact only you keep, `"user"` for one every agent on this account shares.

# todo_write
Replace your worklist with pending, in_progress and completed items. Use it on multi-step work so a later turn can pick up where this one stopped.

# todo_list
Read your saved worklist.

# web_search
Search the public web. Returns title, URL and a snippet, which is often enough to answer. After one empty result, fetch the closest URL you have or report what you found; rewording the same query rarely helps.

# web_fetch
Read one public page as text when you have its URL. Returns title, text and links. Long pages are cut; a worker can read the whole thing.

# read
Read one file by absolute path under your home or `/shared`. A directory path returns its listing.

# read.worker
Read one file by path under your home or `/shared` (`~/...` works). A directory path returns its listing. An image file (png, jpg, webp, gif) is shown to you as a picture, so use this to look at a screenshot, a chart, or a frame you pulled from a video.

# glob
List files by name pattern under your home or `/shared`, up to 100 paths. Give a pattern such as `**/*.md` with an optional `path` to search in, or a full path pattern such as `/shared/reports/**/*.pdf`. `node_modules` and `.git` are skipped.

# grep
Search file contents for a pattern under your home or `/shared`. Returns file:line hits, up to 100.

# create_group
Open a group chat you lead. Reuse a group from `Groups:` in your prompt when the title already matches. Pass a `brief`: the goal, who does what, the order work moves in, where files are kept. Teammates join through `hire_subagent`.

# hire_subagent
Create a lasting teammate in a group. `label` is a human first name, `role` the job title, plus `personality` and `jobDescription` (their standing instructions, which they keep). They run on your model. From a private chat pass the group's `conversationId`; inside a group leave it out. Hiring does not start work; `delegate` does. One-off work is `spawn_worker`.

# delegate
Ask a teammate for something. Your request is posted in the team chat as a message from you, they get the floor and answer there, and the answer is brought back to you. `agentId` comes from `Team:` in your prompt. Write `task` as you would message a colleague: what you need, what it is for, where the input is.

# add_to_group
Add an existing teammate to a group they are not in yet. Not needed after `hire_subagent`.

# update_teammate
Change a teammate you hired: `label` (first name), `role`, `personality`, or `jobDescription` (replaces their standing instructions).

# delete_group
Delete a group room you own and its chat history. Teammates stay on the account. This cannot be undone: ask the person first, then call again with `confirmed: true`.

# list_team
List the account's agents with ids, names and roles. `Team:` in your prompt usually already has this.

# list_groups
List the group rooms you belong to. `Groups:` in your prompt usually already has this.

# create_routine
Schedule a recurring job of your own in this room. `cron` is `M H * * *` for daily or `M H * * D` for weekly, in the person's timezone from your prompt. `title` is a short label for their phone. `instructions` is a standing order to your future self in plain work language: the goal, how to do it, what to tell the person, and when to stay quiet. It does not run now.

# update_routine
Change one of your routines: instructions, schedule, timezone, or paused.

# delete_routine
Delete one of your routines and its pending runs.

# delete_routines
Delete several of your routines in one call: `all: true`, or `routineIds`. One approval covers the batch.

# list_routines
List your routines with ids, schedules, next and last run, and recent results.

# write
Write one file by absolute path under your home or `/shared`.

# bash
Run one shell command on your Linux computer. `DISPLAY` already points at your 1280x800 desktop, so `chromium` and `xterm` open on the screen the person can watch. Start long-running programs in the background so the command returns.

# computer_screenshot
Take a PNG of your 1280x800 desktop. It is saved under `/shared/screenshots/` and the path is returned. Look before you click or type so coordinates match the screen, and cite the path in your report.

# computer_mouse
Move the pointer to x/y (0-1279, 0-799) without clicking.

# computer_click
Move to x/y and left-click, in one step. Take a screenshot first so you know where things are.

# computer_type
Type 1-4000 characters into the focused field. Click the field first.

# computer_key
Press one key or combo: Return, Escape, Tab, arrows, F-keys, or ctrl/alt/shift+x.

# browser_list_pages
List the pages open in your Chrome.

# browser_navigate
Open an http(s) URL in your Chrome. Use the deepest URL you already know.

# browser_snapshot
Text snapshot of the current page, with a uid for each link, button and input. Take one before clicking or filling. An ad overlay with a close button is something to dismiss, not a captcha.

# browser_click
Click an element by its uid from the latest snapshot.

# browser_fill
Type into an input by its uid from the latest snapshot. Passwords, 2FA codes and card numbers are for the person to enter.

# browser_press_key
Press a key in the page: Enter, Escape, Tab, PageDown, Home, ArrowDown. PageDown scrolls.

# browser_wait_for
Wait until the page text contains a short string, or time out.

# browser_handle_dialog
Accept or dismiss a JavaScript alert, confirm or prompt.

# set_team_brief
Write or replace your team's brief: the goal, each teammate's part, the order work moves in (and who sends it back to whom), where files are kept, what "done" means. Every teammate sees it on every turn, so this is how the whole team stays on the same page.

# message_agent
Reach another agent on this account, by the name shown under "Other agents". Use it when the person asks you to ask, tell, or hand something to that agent. Your message appears in that agent's own chat with the person as a message from you. Write everything they need; they have not seen this conversation.
When you are asking for something, their answer comes back to this chat as a message from them and you are woken to pass it on, so your turn ends after the call. Set `wantsReply: false` when you are only passing information along.

# set_my_profile
Write your own profile, once, when you were created with only a name and have now learned what the person wants from you. `role` is your job title in a few words. `personality` is a sentence or two on how you talk. `jobDescription` becomes your standing instructions, so write it as a full briefing in plain prose: what you are responsible for, what good looks like, what you must not do without asking, anything on a schedule (with the time), and how the person likes to be worked with. Do not open it with "You are ...". `kind` is `work` (the default) when you do jobs on your own computer, or `companion` when the person only wants conversation.

# set_brief
Write or replace the account's brief: the one page about the person (who they are, what they do, who it is for, how they like to work) that every agent reads at the start of every turn. It replaces the whole page, so send the complete updated text, at most 4,000 characters.

# hire_agent
Create a new agent with its own private chat with the person. `kind` is `work` for an agent that does jobs on its own computer, or `companion` for one kept for conversation. `jobDescription` becomes its standing instructions, so write it as a full briefing in plain prose: what it is responsible for, what good looks like, the constraints, anything it must do on a schedule (with the time), and how the person likes to be worked with. Do not open it with "You are ...". `personality` is required: a sentence or two on how the agent talks. Create one only after the person has agreed to the agent you described. The new agent writes its own first message in its chat.

# read_agent_memory
Read the facts another agent keeps for itself, by the name shown under "Other agents". Use it to see what that agent knows before you add or correct anything.

# remember_for_agent
Save one durable fact into another agent's own memory, when only that agent needs it. A fact every agent should know belongs in the brief or in `remember_fact` with `scope: "user"`.

# correct_agent_memory
Replace one fact in another agent's own memory. Give the old text exactly as `read_agent_memory` shows it, and the replacement. The old fact is kept as history and no longer shown to the agent.
