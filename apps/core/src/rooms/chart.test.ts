import { chartData, chartScale, chartValue } from "@kuru/shared";
import { describe, expect, it } from "vitest";
import { widgetAsText } from "./send-message.js";

/** Locks what counts as a drawable chart, since the core checks it and the phone draws it from the same reading. */
describe("chart widget", () => {
  it("reads labels with values, several series, and label/value pairs", () => {
    expect(chartData({ type: "line", title: "Followers", labels: ["Jan", "Feb"], values: [1200, 1850], unit: "%" })).toEqual({
      type: "line",
      title: "Followers",
      labels: ["Jan", "Feb"],
      series: [{ name: "", values: [1200, 1850] }],
      unit: "%",
    });
    const grouped = chartData({ labels: ["Q1", "Q2", "Q3"], series: [{ name: "2025", values: [1, 2, 3] }, { name: "2026", values: [2, "4"] }] });
    // No type means bars; a short series is padded to line up with the labels.
    expect(grouped).toMatchObject({ type: "bar", series: [{ name: "2025", values: [1, 2, 3] }, { name: "2026", values: [2, 4, 0] }] });
    expect(chartData({ type: "pie", data: [{ label: "Reels", value: 60 }, { label: "Posts", value: 40 }] })).toMatchObject({
      type: "pie",
      labels: ["Reels", "Posts"],
      series: [{ values: [60, 40] }],
    });
  });

  it("numbers the points when labels are missing, and refuses a chart with no numbers", () => {
    expect(chartData({ values: [5, 7] })?.labels).toEqual(["1", "2"]);
    expect(chartData({ title: "Empty" })).toBeNull();
    expect(chartData({ values: ["a", null] })).toBeNull();
  });

  it("picks a round axis, from zero for bars and close to the data for a line", () => {
    expect(chartScale(12, 87)).toEqual({ min: 0, max: 100, ticks: [0, 50, 100] });
    expect(chartScale(-20, 40)).toMatchObject({ min: -20, max: 40 });
    expect(chartScale(1200, 2600, false)).toEqual({ min: 1000, max: 3000, ticks: [1000, 1500, 2000, 2500, 3000] });
    // A flat series still gets an axis with height.
    expect(chartScale(5, 5).max).toBeGreaterThan(5);
  });

  it("writes values short, with the unit on the right side", () => {
    expect(chartValue(1234567)).toBe("1.23M");
    expect(chartValue(15000, "$")).toBe("$15k");
    expect(chartValue(-250, "$")).toBe("-$250");
    expect(chartValue(45.5, "%")).toBe("45.5%");
    expect(chartValue(120, "ms")).toBe("120 ms");
  });

  it("keeps the numbers in the text the agent later reads back", () => {
    expect(widgetAsText("chart", { type: "pie", title: "Views", labels: ["Reels", "Posts"], values: [60, 40] })).toBe(
      '(Shown to the person as a pie chart: "Views". Reels 60, Posts 40)',
    );
  });
});
