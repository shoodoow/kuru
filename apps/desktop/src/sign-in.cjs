// Google sign-in for the desktop app.
// Google refuses to sign in inside an app window ("This browser or app may
// not be secure"), so the sign-in runs in the person's own browser, where
// they are usually signed in to Google already. The server then sends the
// browser to kuru-desktop://auth?cookie=..., which opens this app with the
// session, and the app keeps it as its own cookie.

const { session, shell } = require("electron");

const SCHEME = "kuru-desktop";
const CALLBACK = `${SCHEME}://auth`;

/**
 * Asks the server for Google's sign-in page and opens it in the browser.
 * The "expo-origin" header is how the server's app sign-in (the Better Auth
 * expo plugin) knows the request comes from a trusted app.
 */
async function startSignIn(server) {
  const response = await fetch(`${server}/api/auth/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json", "expo-origin": `${SCHEME}://` },
    body: JSON.stringify({ provider: "google", callbackURL: CALLBACK, disableRedirect: true }),
  });
  if (!response.ok) throw new Error(`The server did not start sign-in (${response.status}).`);
  const { url } = await response.json();
  if (!url) throw new Error("The server did not return a sign-in page.");
  await shell.openExternal(url);
}

/**
 * Splits the Set-Cookie text the server puts in the link into cookies.
 * Several cookies come joined by ", "; a comma inside a date is not followed
 * by "name=", so it does not split.
 */
function parseSetCookie(text) {
  return text
    .split(/,\s*(?=[^;,=\s]+=)/)
    .map((part) => {
      const [pair, ...attributes] = part.split(";").map((piece) => piece.trim());
      const at = pair.indexOf("=");
      const cookie = { name: pair.slice(0, at), value: pair.slice(at + 1) };
      for (const attribute of attributes) {
        const [key, value = ""] = attribute.split("=");
        const name = key.toLowerCase();
        if (name === "path") cookie.path = value;
        if (name === "httponly") cookie.httpOnly = true;
        if (name === "secure") cookie.secure = true;
        if (name === "max-age") cookie.expirationDate = Date.now() / 1000 + Number(value);
        if (name === "expires" && !cookie.expirationDate) cookie.expirationDate = Date.parse(value) / 1000;
        if (name === "samesite") cookie.sameSite = value.toLowerCase() === "none" ? "no_restriction" : value.toLowerCase();
      }
      return cookie;
    })
    .filter((cookie) => cookie.name);
}

/**
 * Takes the link the browser opened (kuru-desktop://auth?cookie=...) and
 * keeps the session for the server. Output: true when it held a session.
 */
async function finishSignIn(link, server) {
  let text;
  try {
    text = new URL(link).searchParams.get("cookie");
  } catch {
    return false;
  }
  if (!text) return false;
  for (const cookie of parseSetCookie(text)) {
    await session.defaultSession.cookies.set({ url: server, ...cookie });
  }
  return true;
}

module.exports = { SCHEME, startSignIn, finishSignIn, parseSetCookie };
