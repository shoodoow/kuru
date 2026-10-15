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
