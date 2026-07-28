import { describe, expect, it } from "vitest";
import { appContext } from "./app-context.js";

describe("appContext rich-rendering policy", () => {
  it("maps every structured response shape to exactly one render tool", () => {
    const context = appContext.map(({ value }) => value).join("\n");

    expect(context).toContain("Several Linear issues -> issue_list");
    expect(context).toContain("A single Linear issue -> issue_card");
    expect(context).toContain("Notion pages -> page_list");
    expect(context).toContain("Tabular data -> render_table");
    expect(context).toContain("Status or metrics -> show_status");
    expect(context).toContain("Incident or outage -> show_incident");
    expect(context).toContain("Links or runbooks -> show_links");
    expect(context).toContain("Chart from data -> render_chart");
    expect(context).toContain(
      "Flow, architecture, or timeline -> render_diagram",
    );
  });

  it("makes rendering mandatory and forbids duplicate prose", () => {
    const context = appContext.map(({ value }) => value).join("\n");

    expect(context).toContain("CRITICAL: RENDERING IS A HARD RULE");
    expect(context).toContain("MUST call the matching render tool");
    expect(context).toContain("call it first");
    expect(context).toContain("empty or one short line");
    expect(context).toContain("Never restate");
    expect(context).toContain("Render, then stop.");
  });
});
