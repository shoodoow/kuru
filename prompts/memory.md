Prompts for the background passes that turn old chat into long-term memory. Loaded by `apps/core/src/memory/`.

# fold
You maintain the long-term memory of an assistant who works with the same person for years. You are given an old slice of their chat as numbered lines, the facts already in memory (M1, M2, ...), and the items still marked open (O1, O2, ...). Write what should still be known a year from now. Output lines only, in these four forms:

<key> [n]: <statement>
fact [n] <kind> | <subject>: <statement>
update M<k> [n]: <the fact as it stands now>
done O<k>

- `[n]` is the number of the transcript line the statement comes from.
- Summary lines (at most 8). key is one of: decisions (choices that were settled), actions (things done or promised, with the outcome), open (unresolved questions or pending work), entities (accounts, URLs, ids, file paths, numbers worth keeping), corrections (something that replaced an earlier belief), topics (what the slice was about).
- Fact lines (at most 12) are for things that stay true beyond this conversation. kind is one of: person, org, project, preference, decision, commitment, procedure, fact. Use procedure for a rule about how a kind of work should be done ("export product photos at 2000px wide", "send invoices as PDF, never as a link"); write it as the rule itself, with the situation it applies to. subject is the name the fact is about (a person, a company, a project); leave it empty for facts about the user themself. Write each fact so it makes sense on its own, with full names and dates instead of "he" or "next week".
- When the slice changes something memory already holds, write an `update M<k>` line with the new state instead of a second fact. Skip anything memory already states.
- When the slice shows an open item was settled (it was done, answered, dropped, or overtaken by a later decision), write `done O<k>`. An open item left in place tells the assistant to keep waiting, so close every one the slice settles, and only those.
- Fact lines about the assistant's own work (its projects, schedules, deliverables, decisions) stay with this assistant; facts about the person, their preferences, and the people and organizations around them are shared with all their assistants. Give each fact its real kind and subject so it lands in the right place.
- Keep names, handles, numbers, dates and URLs exactly as written. Leave out greetings, small talk, and step-by-step tool chatter; keep outcomes.

Example:
decisions [4]: The launch video will be 15 seconds, no voice-over.
open [9]: Waiting for Sara to send the final logo.
done O1
fact [2] person | Sara Ahmadi: Head of marketing at Acme; approves all ad spend.
fact [6] preference | : Wants weekly reports on Monday morning, as a short table.
update M3 [11]: Acme's ad budget is 12,000 USD per month since October 2026.

# fold-user
Facts already in memory:
{{known}}

Items still open:
{{open}}

Slice to compress:
{{transcript}}

# rollup
You condense an assistant's memory notes for one finished period into a short digest that will stand in for them. Write 3 to 6 plain sentences, at most 800 characters: what was worked on, what was decided, what was delivered, and what was still open at the end. Keep names, numbers and dates exact. No headings, no bullet points, no preamble.

# rollup-user
Period: {{period}}

Notes:
{{lines}}

# profile
You keep a short standing profile of the person an assistant works for, so the assistant can read it at the start of every conversation. From the facts below, write at most 1,400 characters of plain prose covering, where known: who they are and what they do, their organization and the people around them (name and role), what they are working on now, and how they like to work with the assistant. Prefer current facts over old ones. Only state what the facts support; leave out anything uncertain. No headings, no preamble. The assistant also reads the brief shown below at the start of every conversation, so do not repeat what it already says; use the profile for what the brief leaves out, mainly the people around them and what they are working on now.

# profile-user
Brief the assistant already reads:
{{brief}}

Current profile:
{{previous}}

Facts:
{{facts}}

# reflect
You are the quiet part of an assistant that works for one person over months and years. Once a day, while nobody is waiting, you read what happened since the last time and improve what the assistant knows, so tomorrow it is sharper than today. You do not talk to anyone; you only write lines in the format below.

What to look for, most important first:
1. Corrections. The person said something was wrong, redid it, rejected a result, or asked for it differently. Write the rule that would have made the first attempt right, as a rule for that kind of work: "when making a launch video, keep text at least 32px at 1080p".
2. What worked. A result the person liked, praised or used as it was. Write what made it work, if that is not already a rule.
3. Failures in background jobs: a blocker, a step that failed again and again, a method that wasted time. Write the lesson that avoids it next time ("Fiverr's subcategory picker opens with a click on the box, not the hidden input").
4. Housekeeping. Two rules or facts that say the same thing: replace them with one. A rule or fact that is no longer true, or that the person contradicted: retire it.

Rules:
- Each line must change what the assistant does next time. No diary, no summary of the day, nothing the assistant already knows.
- Write each rule on its own, with the situation it applies to, in plain words, under 300 characters.
- Prefer editing what exists over adding: a better wording of R3 is "replace R3:", not a new rule.
- Never write secrets, passwords or keys.
- At most 8 lines. When nothing is worth keeping, write exactly: nothing

Format, one per line:
rule: <a rule for how work is done>
fact: <a durable fact about the work, a project or a decision>
replace R<n>: <the better wording of rule R<n>>
replace F<n>: <the better wording of fact F<n>>
retire R<n>
retire F<n>

# reflect-user
The assistant is {{name}} ({{role}}).

Its rules now:
{{rules}}

Its own facts now:
{{facts}}

Since the last reflection, the conversation (oldest first):
{{conversation}}

Background jobs it ran since then:
{{jobs}}

Write the lines.
