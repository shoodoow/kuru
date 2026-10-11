# Security Policy

## Supported versions

`main` is the only supported branch. Use the latest commit.

## Reporting a vulnerability

Do not open a public issue. Use [GitHub private security advisories](https://github.com/shoodoow/kuru/security/advisories/new)
for this repository and include:

- affected commit / version
- reproduction steps or proof of concept
- impact assessment

Expect an initial response within 72 hours. We will coordinate a fix and
disclosure timeline with you.

## What the software protects, and what it does not

- **Accounts.** Every API route checks the signed-in session against the
  account in the request. Model keys, plugin tokens and vault secrets are
  sealed in Postgres with a key derived from `BETTER_AUTH_SECRET`.
- **Requests the core makes for you.** Plugin sign-in fetches go only to
  public internet addresses; the address is checked when the connection is
  made, not just by name.
- **Agent computers.** Each account has one Linux container. Agents on the
  same account share it and have administrator rights inside it, so they are
  not isolated from each other. No stored secret is given to a container:
  plugin and Google calls, and web searches that use an API key, are made by
  the core. A container can open connections to the
  public internet only: the machine the core runs on, its local network, cloud
  metadata addresses and other accounts' containers are blocked by firewall
  rules the container cannot change (`CONTAINER_FIREWALL=off` removes them).
  With plain Docker, containers share the host kernel, so a kernel exploit is
  not contained. Set `CONTAINER_RUNTIME` to a virtual-machine runtime such as
  Kata Containers on a Linux server to give each account its own kernel; see
  `deploy/SETUP.md`.
- **Auto-review.** Approval cards catch common destructive commands so a
  model's mistake waits for a person. It is a pattern list and can be worked
  around; it is not a security control against a hostile agent.

## Secrets hygiene

- Never commit `.env`, OAuth client secrets, `BETTER_AUTH_SECRET`, API keys,
  tunnel credentials, or Expo tokens.
- `.env.example` files must contain placeholders only (`api.example.com`,
  empty secrets).
- If you accidentally commit a secret: rotate it immediately (Google Cloud,
  Better Auth secret, Exa/Brave keys), then purge it from history
  (`git-filter-repo` / BFG) before pushing anywhere public.
- Production requires `NODE_ENV=production`, unique secrets per environment,
  HTTPS-only OAuth redirect URIs, and Postgres not exposed publicly.
  See `deploy/SETUP.md#security-checklist`.
