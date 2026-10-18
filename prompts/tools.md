Tool descriptions the model sees, one section per tool (`# tool_name`). A `# tool_name.worker` section, when present, replaces the description for background workers. Names, surfaces and input schemas live in `packages/agent-tools/src/definitions.ts`; this file is the only place the wording lives. Loaded by `apps/core/src/turn/tools/build-tools.ts`.

# send_message
Send a bubble to the person now, before your turn is over. Use it for an update after tools have already run, and for rich blocks: `image` (url), `code`, `file` (url + name; the url can be the file's path on your computer, in your home or `/shared`, and the file itself is delivered), and `widget`. Your final plain text is already shown as your reply, so a plain answer needs no call.
Each block is a typed object, for example `{ "kind": "text", "markdown": "On it." }` or `{ "kind": "widget", "widget": "question", "props": { "prompt": "...", "options": [{ "label": "..." }] } }`.
Widgets: `question` (one decision, 1-6 short options you have verified), `poll` (multi-select), `checklist`, `table`, `chart` (see below), `approval`, `agent-card`, `secret` (props.envName required; the only way to ask for a password, token or key), `desktop-handover` (props.message says what to do on your computer; for a login, 2FA or payment step only they can do). `secret` and `desktop-handover` end the turn.

A `chart` widget draws numbers the person should see at a glance; use it instead of a table when the shape of the data is the point. Props: `type` is `bar` (compare categories), `line` (a trend over time) or `pie` (shares of a whole, at most about six slices); `title`; `labels`, one per point; and `values`, the numbers in the same order. To compare several sets on one bar or line chart, give `series` in place of `values`: `[{ "name": "2025", "values": [...] }, { "name": "2026", "values": [...] }]`. Add `unit` (such as `$` or `%`) when the numbers have one. Example: `{ "kind": "widget", "widget": "chart", "props": { "type": "line", "title": "Followers", "labels": ["Jan", "Feb", "Mar"], "values": [1200, 1850, 2600] } }`. Say what the chart shows in a line of text beside it.

# react_to_message
Add one emoji tapback to a message when a reaction is the whole reply: answering the person's reaction, or acknowledging a short message that needs no words.

# notify_user
Your replies already reach the person's phone when they are not in this chat, so a normal answer needs no ping. Use this only for an urgent alert that must stand out from ordinary messages: you are blocked until they act, or something went wrong that they must know now. Not for progress or results.

# spawn_worker
Start a background worker for anything you cannot do with a few quick lookups: shell commands and installs, writing or building files, rendering, a live or login-gated web page, the desktop, or research across several sources. It returns at once and your turn ends; the finished report is delivered to you on its own.
The worker sees only `task`, plus what is attached for you: the person's recent messages, their brief, and your saved procedures. It knows nothing else from this chat, so the brief must stand on its own: no "as discussed", no "the usual way". Write it as the problem and the outcome: what to produce, every requirement the person gave (size, length, style, things to leave out), the exact URLs or paths you know, what done looks like, and what to report back. Leave the method to the worker: no step-by-step commands, no version numbers you are not sure of, no diagnosis you have not verified. The worker keeps going until the job is finished and checks its own result, so give it the whole job in one brief.
Each new job starts with a fresh worker, except work that was cut off unfinished, which goes back to the worker that started it; the result says `continued` when that happened. To change or fix something a worker already finished, use `redirect_worker` with its id instead.
`kind`: `executor` general work (default) · `shell` commands and installs · `explore` find and read files · `browser` live web pages that need clicking or reading · `computer` desktop GUI apps · `docs` read public documentation · `debug` evidence-based debugging · `vm_setup` set up a project · `watch_video` / `video_review` media.
`skills`: a list of skill names the worker should follow, for example `["docx"]`. Their main text is loaded for it, so you do not read them first. The worker also sees the other installed skills by name and can load one itself.
`briefFile`: a file holding the full brief, for a long brief or one you will reuse: write it with `write`, then pass its path; its text goes to the worker with `task`, so keep `task` to the goal in a line or two. Your saved procedures and the person's brief are attached for you; do not copy them.

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
List the skills you can load. Skills are shared across the account: one installed by any agent is available to all of them. `query`: words for what you need (for example "video captions"), to get only the best matches with their full descriptions. Without it, every skill comes back with a one-line description.

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
`kind: "procedure"` (with `scope: "agent"`) for how the person wants a kind of work done: "when you do Y, use X". Every worker you start receives your procedures, so save one whenever the person corrects how work was done or tells you how they want it done; it is how the correction reaches the next job.

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
Schedule a recurring job in this room. `cron` is `M H * * *` for daily or `M H * * D` for weekly, in the person's timezone from your prompt. `title` is a short label for their phone. It does not run now.
`runAs` decides who wakes up. `worker` (the default for real work: posting, checking an inbox, building a report, anything done on the computer) starts a worker straight away on every run, without waking you; you hear back only when its report has something for the person. `agent` wakes you instead; use it only when the run is a conversation with the person (a check-in question, a reminder, a daily chat).
For `worker`, `instructions` is the worker's whole brief, and nobody will be there to explain it: no chat history, no "as discussed". Write it so a capable stranger could do the job from it alone: the goal and why it matters, where to work (exact sites, accounts, folders), what done looks like, every requirement and limit the person gave, what must never happen without asking, and what counts as worth telling the person versus a quiet run. Leave the step-by-step method to the worker. When the brief is long or you will refine it over time, write it to a file with `write` (for example `/shared/briefs/inbox-sweep.md`), pass it as `briefFile`, and keep `instructions` to a two-line summary; the file is read fresh on every run, so editing it changes the next run. `kind` and `skills` work as in `spawn_worker`. The worker keeps a notes file of what worked between runs, and receives your saved procedures, so a correction saved with `remember_fact` and `kind: "procedure"` reaches the next run without editing the routine.

# update_routine
Change one of your routines: instructions, schedule, timezone, paused, `runAs`, `kind`, `skills`, or `briefFile` (an empty string stops using the file). To change only how the work is done, edit its brief file or save a procedure instead.

# delete_routine
Delete one of your routines and its pending runs.

# delete_routines
Delete several of your routines in one call: `all: true`, or `routineIds`. One approval covers the batch.

# list_routines
List your routines with ids, schedules, next and last run, and recent results.

# write
Write one file by absolute path under your home or `/shared`. With `append: true` the body is added to the end instead: write a long file in parts of a few hundred lines each.

# bash
Run one quick shell command on your own Linux computer: check something, run a script you wrote, convert a file, look at a result. You have about 20 seconds per call, and the output is cut if it is long. A job that takes longer, installs programs, builds, renders or needs many commands goes to `spawn_worker`. Never use it to start a browser.

# bash.worker
Run one shell command on your Linux computer. `DISPLAY` already points at your 1280x800 desktop, so `chromium` and `xterm` open on the screen the person can watch. A command may run up to 30 minutes, so a render, a voice-over or an install can run in the foreground and you get the result in one step. Start a program in the background only when you need to do other work meanwhile, then use `wait`.

# wait
Wait for something running in the background to finish, in one step instead of many checks. `until` is a shell check that succeeds when it is done, such as `! pgrep -f render.mjs` or `test -s out/voice.wav`; it is tried every 10 seconds. `minutes` is the most to wait (up to 30, 15 if left out). `log` is a file whose last lines you get back. The answer says whether it finished or is still running.

# ask_agent
Ask the agent you work for one question, and wait for the answer. It knows the whole conversation with the person, their preferences and what was decided before, and it can ask the person if only they know. Use it when you are stuck on something you cannot find out yourself: which of two options they want, a detail the brief left out, a file or account you were not given, whether to go on after something unexpected. Give `question`, the `options` you see when there are a few, and your `pick`. If no answer comes within a few minutes you carry on with your pick. Two questions per job. Do not ask how to do the work: looking things up, reading a tool's help and trying are your job.

# computer_memory
Your computer has a modest everyday memory limit. Before a job that needs more (rendering video, a large build, a big data file), call this with action `request`, `gb` (what the job needs in all) and `minutes` (how long it may take). The answer says how much you got: plan the job's thread or worker count to fit that, since a job that goes over is killed. If the answer is "not granted", another account's job has the spare memory: run with fewer threads, or do other work and ask again. Call action `release` as soon as the job is done, because other accounts wait for that memory. `status` shows your limit and what is in use.

# computer_screenshot
Take a PNG of your 1280x800 desktop. It is saved under `/shared/screenshots/` and the path is returned. Look before you click or type so coordinates match the screen, and cite the path in your report.

# computer_mouse
Move the pointer to x/y (0-1279, 0-799) without clicking.

# computer_click
Move to x/y and left-click, in one step. Take a screenshot first so you know where things are. `holdMs` presses and holds there with the real mouse: use it for a "press and hold" check in the browser when `browser_click` with `holdMs` did not clear it (find the button with `computer_screenshot`, hold 10000 to 20000, and hold again if it asks).

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
The current page as a tree: headings, text, links (with their addresses), buttons and fields, each with a ref such as `e12` that the other browser tools take. The first snapshot shows the whole page; after that you get only what changed since your last one (a menu that opened, a field that appeared, what went away), and the rest of the page is as you last saw it. Pass `full: true` when you need the whole page again, for example after your earlier steps were collapsed. `scope` is a CSS selector for one part ("form", "[role=dialog]"); `interactive: true` leaves out plain text. An ad or cookie overlay with a close button is something to dismiss, not a captcha.

# browser_read
The text of the page now open in your browser, as a person would read it. Use it to get an answer out of a page you opened.

# browser_read.worker
The page as clean readable text (markdown), without the tree. `outline: true` gives just its headings, to see what it covers first; `filter` keeps only the sections that mention a word; `uid` reads one part (an article, a table, a card). Use this to get an answer out of a page; use `browser_snapshot` to find what to click.

# browser_click
Click a link, button or other element by its ref from the latest snapshot; `double: true` double-clicks. It is a real mouse click, scrolled into view first. `holdMs` keeps the button pressed that long before letting go, only for a control that says "press and hold" (start with 10000 and go longer if it asks again); never add it to an ordinary click. A dropdown or picker opens with a plain click on it; then take a snapshot, which shows its options, and click the one you want. Typing into a picker only filters a menu that is already open. The result says which page you are on afterwards. If the page changed, take a new snapshot before the next action.

# browser_click_at
Click at a pixel position in the page, for what has no ref: a canvas, a map, a picture, a custom control. Take a `browser_screenshot` first and read the position from it. `holdMs` presses and holds there, as in `browser_click`.

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
Attach a file from your home or `/shared` to the page's file field, without opening the file picker. Give only `path`: it finds the field itself, even when the page hides it behind an "Upload" button or a drop area. When the page has more than one, it lists them and you call again with `field` set to the one you want. Never open the system file picker or a file manager to attach a file; it is slow and often fails. Check the page afterwards with `browser_snapshot`.

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
Run a line of JavaScript in the page and get its result, for what the other tools cannot reach: reading a value the page does not show, a count of rows, a field in a frame. It is a last resort, and it never replaces clicking for anything a site would treat as a person's action: an `element.click()` from a script does not open menus, dropdowns or pickers, because sites listen for a real pointer. Use `browser_click` for those; when it says the element is covered, it clicks there with the mouse for you.

# browser_tabs
`list` the open tabs, open a `new` one at a `url`, `switch` to one or `close` one by its id (such as `t2`). A link that opens a new tab leaves you on the old one until you switch.

# browser_wait_for
Wait for what an action should cause, instead of looking again and again: `text` until the page shows it, `gone` until a text such as "Loading" or "Saving" is no longer there, `url` until the address matches (after a submit), or `load` ("networkidle" until the page stops fetching). It times out by itself.

# browser_handle_dialog
Accept or dismiss a JavaScript alert, confirm or prompt.

# browser_screenshot
Look at the page as a picture. Use it only when the tree does not tell you what you need: a chart, an image, a layout that looks wrong, a canvas. It costs far more than a snapshot. `annotate: true` numbers every control on the picture with its ref ([12] is `e12`), so you can click what you see by ref instead of guessing a position.

# browser_batch
Several page actions in one call, run in order, stopping at the first that fails. Use it for fields you can already see, not to click through a menu you have not opened yet: fill a whole form and submit it, or open a dropdown and pick an option. Each step is `{ action, ... }` with the same fields as the single tool: `click` (uid), `fill` (uid, value), `type` (uid, text, enter), `select` (uid, value), `check` (uid, checked), `set_value` (field, value), `press_key` (key), `scroll` (direction, pixels), `hover` (uid), `wait_for` (text or gone). Use refs from your latest snapshot; take a snapshot afterwards to check the result. One batch saves the steps that one call per field would cost.

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

# fire_agent
Remove one of the person's agents for good, by the name shown under "Other agents": the agent, its chat and everything in it, its routines, its background work and the facts it kept for itself. What it learned about the person stays with their other agents. It cannot be undone, so use it only when the person has clearly said to let that agent go, and the person must still approve the card it shows. It cannot remove you, and an agent that leads a group needs that group deleted first. Afterwards, update the brief's "Who does what" in the same turn.

# read_agent_memory
Read the facts another agent keeps for itself, by the name shown under "Other agents". Use it to see what that agent knows before you add or correct anything.

# remember_for_agent
Save one durable fact into another agent's own memory, when only that agent needs it. A fact every agent should know belongs in the brief or in `remember_fact` with `scope: "user"`.

# correct_agent_memory
Replace one fact in another agent's own memory. Give the old text exactly as `read_agent_memory` shows it, and the replacement. The old fact is kept as history and no longer shown to the agent.
