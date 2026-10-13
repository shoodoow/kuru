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
Run one quick shell command on your own Linux computer: check something, run a script you wrote, convert a file, look at a result. You have about 20 seconds per call, and the output is cut if it is long. A job that takes longer, installs programs, builds, renders or needs many commands goes to `spawn_worker`. Never use it to start a browser.

# bash.worker
Run one shell command on your Linux computer. `DISPLAY` already points at your 1280x800 desktop, so `chromium` and `xterm` open on the screen the person can watch. Start long-running programs in the background so the command returns.

# ask_agent
Ask the agent you work for one question, and wait for the answer. It knows the whole conversation with the person, their preferences and what was decided before, and it can ask the person if only they know. Use it when you are stuck on something you cannot find out yourself: which of two options they want, a detail the brief left out, a file or account you were not given, whether to go on after something unexpected. Give `question`, the `options` you see when there are a few, and your `pick`. If no answer comes within a few minutes you carry on with your pick. Two questions per job. Do not ask how to do the work: looking things up, reading a tool's help and trying are your job.

# computer_memory
Your computer has a modest everyday memory limit. Before a job that needs more (rendering video, a large build, a big data file), call this with action `request`, `gb` (what the job needs in all) and `minutes` (how long it may take). The answer says how much you got: plan the job's thread or worker count to fit that, since a job that goes over is killed. If the answer is "not granted", another account's job has the spare memory: run with fewer threads, or do other work and ask again. Call action `release` as soon as the job is done, because other accounts wait for that memory. `status` shows your limit and what is in use.

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
List the tabs open in your browser, with the id of each.

# browser_navigate
Open an http(s) page in your own browser and get it back as text: its title, its content, and any notes you kept about the site. This is for looking: reading a live or signed-in page that `web_fetch` cannot read. You cannot click, type or submit from here. A job that needs any of that (filling a form, ordering, posting, signing in, clicking through) goes to `spawn_worker` with kind `browser`, in full, without trying it yourself first.

# browser_navigate.worker
Open an http(s) URL in the current tab of your browser and wait for it to load. Use the deepest URL you already know, not the site's home page. The result is the page: its title, then its tree with a ref (`e12`) on everything you can act on, and any notes you kept about this site from earlier visits.

# browser_snapshot
The page now open in your browser, as a tree of its headings, text and links. For looking only: to act on the page, hand the job to a `browser` worker.

# browser_snapshot.worker
The current page as a tree: headings, text, links (with their addresses), buttons and fields, each with a ref such as `e12` that the other browser tools take. Take one after anything that changes the page; refs from an older snapshot may be gone. `interactive: true` leaves out plain text and is much shorter: use it on a long page when you only need to find a control. An ad or cookie overlay with a close button is something to dismiss, not a captcha.

# browser_read
The text of the page now open in your browser, as a person would read it. Use it to get an answer out of a page you opened.

# browser_read.worker
The page's text, as a person would read it, without the tree. Pass `uid` to read just one part (an article, a table, a card). Use this to get an answer out of a page; use `browser_snapshot` to find what to click.

# browser_click
Click a link, button or other element by its ref from the latest snapshot; `double: true` double-clicks. It is a real mouse click, scrolled into view first. The result says which page you are on afterwards. If the page changed, take a new snapshot before the next action.

# browser_click_at
Click at a pixel position in the page, for what has no ref: a canvas, a map, a picture, a custom control. Take a `browser_screenshot` first and read the position from it.

# browser_hover
Move the pointer over an element by its ref, to open a menu or show a tooltip that appears on hover. Snapshot again to see what appeared.

# browser_drag
Drag one element onto another, both by ref: reordering a list, moving a card, a slider handle.

# browser_type
Type text key by key, the way a person does. Use it where `browser_fill` is ignored or where the page reacts to each key: search boxes with suggestions, chat boxes, rich text editors. `uid` names the field; without it the keys go to whatever has focus. `enter: true` presses Enter afterwards.

# browser_check
Tick a checkbox or radio button by its ref; `checked: false` clears it.

# browser_fill
Clear a text field and type into it, by its ref. Not for date, time, slider or colour fields: those are listed under the snapshot and set with `browser_set_value`. Passwords, 2FA codes and card numbers are for the person to enter.

# browser_select
Choose an option in a dropdown by its ref, giving the option's visible label.

# browser_set_value
Set a date, time, date-and-time, month, week, slider or colour field. The browser draws these as several small parts (hours, minutes, AM/PM), and `browser_fill` or typing into a part does not work and can put the text into another field. Every snapshot lists these fields under the page with their name: pass that name as `field`, and the value in the field's own form: `13:45` for a time (24-hour), `2026-10-20` for a date, `2026-10-20T13:45` for a date and time, a number for a slider, `#ff8800` for a colour. The result says what the field holds afterwards, and what it accepts if it refused.

# browser_upload
Attach a file from your home or `/shared` to a file field, by the field's ref.

# browser_press_key
Press a key in the page: Enter (submits a form), Escape, Tab, ArrowDown, or a combination such as Control+a.

# browser_scroll
Scroll the page `up`, `down`, `left` or `right` (default down, 700 pixels). Pages that load more as you scroll need this before a snapshot shows the rest.

# browser_back
Go back one page.

# browser_reload
Load the current page again.

# browser_download
Click a download link or button by its ref and keep the file. `name` is the file name to save it under; it lands in `~/Downloads` and the result gives the path.

# browser_eval
Run a line of JavaScript in the page and get its result, for what the other tools cannot reach: reading a value the page does not show, a count of rows, a field in a frame. It is a last resort, and it never replaces clicking for anything a site would treat as a person's action.

# browser_tabs
`list` the open tabs, open a `new` one at a `url`, `switch` to one or `close` one by its id (such as `t2`). A link that opens a new tab leaves you on the old one until you switch.

# browser_wait_for
Wait until the page shows a short piece of text, or time out. Use it after an action that loads something slowly.

# browser_handle_dialog
Accept or dismiss a JavaScript alert, confirm or prompt.

# browser_screenshot
Look at the page as a picture. Use it only when the tree does not tell you what you need: a chart, an image, a layout that looks wrong, a canvas. It costs far more than a snapshot.

# set_team_brief
Write or replace your team's brief: the goal, each teammate's part, the order work moves in (and who sends it back to whom), where files are kept, what "done" means. Every teammate sees it on every turn, so this is how the whole team stays on the same page.

# message_agent
Reach another agent on this account, by the name shown under "Other agents". Use it when the person asks you to ask, tell, or hand something to that agent. Your message appears in that agent's own chat with the person as a message from you. Write everything they need; they have not seen this conversation.
When you are asking for something, their answer comes back to this chat as a message from them and you are woken to pass it on, so your turn ends after the call. Set `wantsReply: false` when you are only passing information along.

# connect_social
Connect the person's Instagram or TikTok so you can post and manage it. Call it when they ask you to connect or post and nothing is connected yet, and follow the `do` field of each answer. The tool itself shows the person the setup steps with hidden fields for their developer app's two keys, and later the sign-in link, so you do not write those yourself; you only say a short line around them. The connection is yours alone unless `forAllAgents` is true. Call it again after each thing the person does. You never see the keys or any token: you only name them, and the server holds them. Call it with no extra arguments to see what is connected, and with `disconnect: true` (and `account` for one of several) when the person wants an account signed out. YouTube is not connected here: the person adds it on the Plugins page.

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
