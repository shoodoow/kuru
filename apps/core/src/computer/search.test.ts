import { describe, expect, it } from "vitest";
import {
  braveFreshness,
  withSites,
  clearSearchOutage,
  isDuckBotCheck,
  noteSearchOutage,
  searchOutage,
  parseApiError,
  parseExaResponse,
  parseBraveResponse,
  selectSearchProvider,
} from "./search.js";

describe("web search providers", () => {
  it("prefers Exa over Brave for agent search", () => {
    expect(selectSearchProvider({ exaKey: "x", braveKey: "y" })).toBe("exa");
    expect(selectSearchProvider({ braveKey: "y" })).toBe("brave");
    expect(selectSearchProvider({})).toBe("duckduckgo");
  });

  it("parses Exa results with contents text and highlights", () => {
    const raw = JSON.stringify({
      results: [
        {
          title: "Pricing",
          url: "https://docs.example/pricing",
          text: "Input tokens $3 per million.",
          highlights: ["$3 per million input"],
        },
      ],
    });
    const rows = parseExaResponse(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.snippet).toContain("$3 per million");
  });

  it("combines summary, highlights, and text so one search answers", () => {
    const raw = JSON.stringify({
      results: [
        {
          title: "Pricing",
          url: "https://docs.example/pricing",
          summary: "Input is $3 per million tokens.",
          highlights: ["$3 per million input"],
          text: "Full pricing page body with output at $15.",
        },
      ],
    });
    const rows = parseExaResponse(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.snippet).toContain("$3 per million tokens");
    expect(rows[0]!.snippet).toContain("$15");
    expect(rows[0]!.snippet.length).toBeGreaterThan(50);
  });

  it("surfaces provider API errors", () => {
    expect(parseApiError('{"error":"Invalid API key"}')).toBe("Invalid API key");
    expect(parseBraveResponse('{"web":{"results":[{"title":"A","url":"https://a.com","description":"hi"}]}}')).toHaveLength(1);
  });

  it("recognises DuckDuckGo's bot check, so it is never reported as no results", () => {
    const botCheck = '<form id="challenge-form" action="//duckduckgo.com/anomaly.js?sv=lite"><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div></form>';
    expect(isDuckBotCheck(botCheck)).toBe(true);
    expect(isDuckBotCheck('<a rel="nofollow" href="https://a.com">A</a>')).toBe(false);
  });

  it("remembers a search outage for a while, then forgets it", () => {
    clearSearchOutage("acct");
    expect(searchOutage("acct")).toBeNull();
    noteSearchOutage("acct", "blocked", 1_000, 10_000);
    expect(searchOutage("acct", 10_500)?.reason).toBe("blocked");
    expect(searchOutage("acct", 11_001)).toBeNull();
  });

  it("knows a search engine's results page when a worker tries to fetch one", async () => {
    const { isSearchResultsPage } = await import("./linux-tool-executes.js");
    expect(isSearchResultsPage("https://www.google.com/search?q=magnaflow+ceo")).toBe(true);
    expect(isSearchResultsPage("https://search.brave.com/search?q=x")).toBe(true);
    expect(isSearchResultsPage("https://html.duckduckgo.com/html/?q=x")).toBe(true);
    expect(isSearchResultsPage("https://www.mojeek.com/search?q=x")).toBe(true);
    expect(isSearchResultsPage("https://www.google.com/maps/place/x")).toBe(false);
    expect(isSearchResultsPage("https://magnaflow.com/pages/about?ref=1")).toBe(false);
  });
});

describe("search filters", () => {
  it("adds site terms for engines without a site list", () => {
    expect(withSites("configurator", ["reddit.com"])).toBe("configurator site:reddit.com");
    expect(withSites("configurator", ["reddit.com", "upwork.com"])).toBe("configurator (site:reddit.com OR site:upwork.com)");
    expect(withSites("configurator", undefined)).toBe("configurator");
  });

  it("maps days to Brave's freshness windows", () => {
    expect(braveFreshness(1)).toBe("pd");
    expect(braveFreshness(2)).toBe("pw");
    expect(braveFreshness(30)).toBe("pm");
    expect(braveFreshness(200)).toBe("py");
  });

  it("keeps Exa's publish date", () => {
    const rows = parseExaResponse(JSON.stringify({ results: [{ title: "T", url: "https://a.com", text: "body", publishedDate: "2026-10-19T08:00:00.000Z" }] }));
    expect(rows[0]?.date).toBe("2026-10-19");
  });
});
