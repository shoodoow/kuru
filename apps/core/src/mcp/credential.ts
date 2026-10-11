import { open, seal } from "../keys/keys.js";

const MARK = "oauth1.";

/** Refresh material for a user-supplied MCP. Kept sealed on the core; no part of it is given to the container. */
export type OAuthSecret = {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  tokenEndpoint: string;
  clientId: string;
  /** The server the token is for; sent again on every refresh. Absent on sign-ins saved before it was recorded. */
  resource?: string;
};

export function sealOAuth(value: OAuthSecret): string {
  return seal(MARK + JSON.stringify(value));
}

/**
 * Opens a stored connector secret.
 * Input: the sealed value. Output: a bearer ready to send, plus oauth material when the secret is a refresh bundle.
 * An expired access token comes back as an empty bearer so the caller can refresh it on the core.
 */
export function readSecret(sealed: string): { bearer: string; oauth: OAuthSecret | null } {
  if (!sealed) return { bearer: "", oauth: null };
  const plain = open(sealed);
  if (!plain.startsWith(MARK)) return { bearer: plain, oauth: null };
  const oauth = JSON.parse(plain.slice(MARK.length)) as OAuthSecret;
  const fresh = oauth.expiresAt > Date.now() + 60_000 && oauth.accessToken.length > 0;
  return { bearer: fresh ? oauth.accessToken : "", oauth };
}
