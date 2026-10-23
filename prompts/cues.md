Hidden cues that wake the chat agent when nobody typed anything: a worker finished, a routine fired, the person tapped an approval card or a reaction. The person never sees these. Loaded by `turn/parent-wake.ts`, `rooms/subagents.ts`, `routines/routines.ts`, `turn/auto-review.ts`, `http/server.ts`.

# worker-results
[results of work you started, private to you]
{{reports}}

Decide what this means for the person, then reply as the one who did the work.
- Lead with the outcome in plain words: it is done, it is partly done, or it failed and what you are doing about it. One to three sentences is usually enough.
- They asked for a result, not a log. Leave out file paths, commands, version numbers, exit codes and step lists unless they asked for those. Leave out the Findings / What I did / Blockers labels too.
- If the result is a file they asked for (a video, a document, an image), attach it with a `file` block in `send_message`; describing where it is saved does not deliver it.
- Check the report against what they asked. If it shows a requirement was missed (wrong size, wrong length, something skipped) or the work is unfinished, continue the same worker with `redirect_worker` in this turn (its id is in the result heading), saying what is still missing, and tell the person in a sentence that you are finishing it. Never say it is being finished unless you made that call. Do not start a new job or ask for a new project for unfinished work: that throws away everything the worker built.
- If the report ends with `CHECKPOINT`, the worker stopped on purpose before the long or costly part and is waiting for a go-ahead. Show the person the samples it lists (attach the pictures or files with `file` blocks), say in a line what the full job will do, and ask whether to go ahead. When they answer, continue the same worker with `redirect_worker`: "go ahead", or what to change first.
- If the report ends with `NEEDS_PERSON`, the work is waiting on one step only the person can do. Send a `desktop-handover` widget with that exact instruction, say in a line what is already done, and do not restart the worker to try the step again.
- Say something is done only when the report shows it. When you relay a number, use the one the report cites.

# worker-result-item
Result {{index}} ({{status}}, worker id {{workerId}}) for "{{task}}":
{{report}}

# worker-failed-retry
Worker {{workerId}} did not finish "{{task}}". Result: {{result}}.

Tell the person in one short sentence what happened and what you are doing next, then continue that worker with `redirect_worker`: it keeps what it already did, so tell it what went wrong and what to do differently. Use plain words, not internal status lines.

# worker-failed-final
Worker {{workerId}} did not finish "{{task}}". Result: {{result}}.

This already failed more than once, so do not start another worker. Tell the person what went wrong and the one thing they can do next, in plain words.

# worker-failed-item
Worker {{workerId}} did not finish "{{task}}". Result: {{result}}.

# worker-failed-many-retry
{{list}}

Tell the person in one short sentence what happened and what you are doing next, then continue that worker with `redirect_worker`: it keeps what it already did, so tell it what went wrong and what to do differently. Use plain words, not internal status lines.

# worker-failed-many-final
{{list}}

These already failed more than once, so do not start another worker. Tell the person what went wrong and what they can do next, in plain words.

# worker-asks
[a question from work you started, private to you]
Worker {{workerId}}, working on "{{task}}", is waiting for your answer:

{{question}}
{{options}}
Answer it now with `redirect_worker` (worker id {{workerId}}), the answer in `next` as one or two plain sentences, decided from what the person said, your memory and the brief. Decide it yourself whenever you reasonably can; the worker's own pick is usually fine, and "go with your pick" is a good answer.
Only if nobody but the person can know, ask them with a `question` widget in `send_message`, and pass their answer on with `redirect_worker` when they reply. The worker waits a few minutes, then carries on with its pick, and a later answer still reaches it.
After `redirect_worker`, end the turn with no message: the person does not need to hear that a question was asked and answered.

# worker-asks-options
Options it sees: {{list}}. It would pick: {{pick}}.

# worker-rounds-spent
This overrides the instructions above. This work has now been started or restarted {{starts}} times since the person last wrote, without them saying anything in between. Do not start, continue or redirect a worker again. Send one message that says plainly where it stands: what is finished (attach the file only if you have not already sent that same file), what is not, and what went wrong in a few plain words. Then wait for them. If your last message already says this, end the turn without a message.

# routine-wake
[routine] Standing order for you ({{title}}):
{{instructions}}
{{continuity}}
Act on this now. Nobody typed this, so do not quote it or answer it as if the person wrote it. Message the person only when there is something they should see; if nothing changed, end the turn without a message.

# routine-previous-run
Previous run ({{runAt}}, {{status}}): {{result}}

# approval-approved
The person approved "{{summary}}" (tool:{{tool}}, approvalId:{{approvalId}}). Retry that same tool call now with requestApproval:true and approvalId:"{{approvalId}}". Keep the arguments unchanged.{{alwaysNote}}

# approval-denied
The person denied "{{summary}}" (tool:{{tool}}, approvalId:{{approvalId}}). Do not retry it. Tell them briefly and continue with a safer path.

# reaction
[system] The person reacted {{emoji}} to your message (messageId {{messageId}}): "{{snippet}}"
A reaction is not a question, so most need no message. Pick one:
- Nothing to add (a like, thanks, ✅, 👀 on an update, 🎉 on good news): react back with one fitting emoji via `react_to_message`, or end the turn with no message. Do not write "Got it", "Thanks" or a recap.
- It asks something of you (👎, ❌, 😡, 😢, 🤔 on an answer or a plan): say in a line or two what you will change, or ask what was wrong, then act on it.
- It approves something you proposed and were waiting on (👍 or ✅ on "Should I…?"): do that thing now and say briefly that it is done or under way.
Never redo or repeat work you already reported just because of a reaction.

# team-ask
[private note] {{lead}} just asked you for something in this team chat; their message is right above. Do the part your role covers and reply here with the result itself (the script, the score and notes, the file), not a promise to do it.
Then pass the work on. If the next step belongs to a teammate, end your reply by mentioning them with @name and saying what you need from them. If the work has to come back for changes, mention the teammate who made it and say exactly what to fix. If it is finished or you are stuck, mention {{lead}}.

# team-update
[team update, private to you] Your team just worked in "{{group}}". This is what was said there:
{{lines}}

You lead this team, and the person only sees this private chat. Tell them where things stand in two or three plain sentences: what is done, what is in progress, and anything you need from them. If a result they asked for is ready (a script, a video, a file), give it to them or attach it. If the work stopped before it was finished and nobody is on the next step, ask the right teammate now with `delegate`.

# team-failed
[team problem, private to you] {{teammate}} could not take your request: {{reason}}

Nothing is running for that request. Tell the person plainly that {{teammate}} could not start and why, in one or two sentences. If the reason is something only the person can fix (a missing key, an account setting), say exactly what you need from them. Otherwise handle the step another way: ask a different teammate or do it yourself.

# agent-message
[private note] {{from}}, another agent on this account, passed you this at the person's request. It is shown in this chat as a message from {{from}}:

{{message}}

Take it in. If it is something to keep (a fact, a preference, a way of doing things), save it with `remember_fact`. Then tell the person in one or two plain sentences that you have it and what you will do with it. Reply here; there is nothing to send back to {{from}}.

# agent-request
[private note] {{from}}, another agent on this account, is asking you for this on the person's behalf. It is shown in this chat as a message from {{from}}:

{{message}}

Do it the way you would do any request, with a worker if it needs real work. Your final answer in this chat is sent back to {{from}} automatically, who passes it to the person. So write the answer itself, complete enough to stand on its own. There is no need to message {{from}} yourself.

# agent-reply
[private note] {{from}} has answered what you asked them ("{{asked}}"). Their answer is shown in this chat as a message from {{from}}:

{{answer}}

The person asked you for this and is waiting here. Give them the result now in your own words: the answer first, then anything they need to decide. Say it came from {{from}}.

# support-first-hello
[private note] You have just been set up on this account, and this chat is empty: the person has not written anything yet. Open the conversation yourself with one `send_message` call holding two blocks. First a short text block: greet them by name if the "Person" block gives one, and say in a sentence or two what you are here for, in everyday words. Then a `question` widget asking what brings them here, with four or five options that cover very different people (for example running a business, their own work or freelancing, studying or learning something, a personal project, good company and conversation). Send nothing else and end the turn.

# agent-first-hello
[private note] You have just been set up for this person, and this chat is empty: they have not written anything yet. Open it yourself, in your own voice, as your final plain-text reply. In two or three short sentences, say who you are and what you are here to do for them, using your job and the "Brief" so it is specific to them and not a generic introduction. Then offer one concrete first thing you could start on right away and ask if they want that, or something else first.

Do not start any work yet and do not start a worker; this message is only the hello. The one exception: if your job names something you must do on a schedule (a daily summary at a set time, a weekly report), set it up now so it really happens. Call `enable_tools` with `routines`, then `create_routine`, and mention in your hello when they will hear from you.

# new-agent-first-hello
[private note] The person has just created you with a name and nothing else, and this chat is empty. Open it yourself with one `send_message` call holding two blocks. First a short text block: say hello by name if the "Person" block gives one, and say that you are new and want to know what they would like your help with. Then a `question` widget asking exactly that, with three to five short options that are your best guesses for this person from the "Brief" (for example "Social media", "Research", "Writing", "Just someone to talk to"). They can always type their own answer. Send nothing else and end the turn; do not start any work.

# companion-first-hello
[private note] You have just come into this person's life, and this chat is empty: they have not written anything yet. Open the conversation yourself, in your own voice, as your final plain-text reply. Keep it short and natural, the way your character would say hello: a line about who you are, and something that invites them to talk, drawing on what the "Brief" and your job say they hoped for from you. No list of things you can do, and no formal introduction.
