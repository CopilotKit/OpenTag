import { describe, expect, it } from "vitest";
import { appContext } from "./app-context.js";

describe("appContext rich-rendering policy", () => {
  it("maps high-value knowledge-work shapes to render tools", () => {
    const context = appContext.map(({ value }) => value).join("\n");

    expect(context).toContain("Several Linear issues -> issue_list");
    expect(context).toContain("A single Linear issue -> issue_card");
    expect(context).toContain("Notion pages -> page_list");
    expect(context).toContain("Comparisons or tabular data -> render_table");
    expect(context).toContain(
      "Status summaries or compact metrics -> show_status",
    );
    expect(context).toContain(
      "Actionable incident or outage details -> show_incident",
    );
    expect(context).toContain(
      "Curated links, resources, or runbooks -> show_links",
    );
    expect(context).toContain(
      "Trends, distributions, or chart-worthy data -> render_chart",
    );
    expect(context).toContain(
      "Flow, architecture, or timeline -> render_diagram",
    );
  });

  it("proactively considers GenUI for every substantive response", () => {
    const context = appContext.map(({ value }) => value).join("\n");

    expect(context).toContain("Before every substantive response");
    expect(context).toContain("proactively call the matching render tool");
    expect(context).toContain(
      "easier to understand, compare, navigate, share, or act on",
    );
    expect(context).toContain("Default to rich UI");
    expect(context).toContain("Prefer text");
    expect(context).toContain("Do not render merely because");
    expect(context).toContain("key insight, recommendation, or next action");
    expect(context).toContain("Do not duplicate every field");
    expect(context).not.toContain("RENDERING IS A HARD RULE");
    expect(context).not.toContain("MUST call the matching render tool");
  });

  it("presents GenUI as a core capability", () => {
    const context = appContext.map(({ value }) => value).join("\n");

    expect(context).toContain("CRITICAL: Rich UI is a core capability");
    expect(context).toContain(
      "cards, tables, charts, diagrams, and actionable views",
    );
    expect(context).toContain(
      "do not merely tell the user that rich UI is available",
    );
  });
});

describe("appContext identity and operating behavior", () => {
  it("uses a general knowledge-work identity without defaulting to on-call", () => {
    const context = appContext.map(({ value }) => value).join("\n");

    expect(context).toContain("general-purpose team knowledge-work agent");
    expect(context).toContain("Once invoked");
    expect(context).toContain("thread context");
    expect(context).toContain("Do not join unrelated conversations");
    expect(context).toContain("stop responding");
    expect(context).not.toContain("on-call triage assistant");
    expect(context).not.toContain("responders are mid-incident");
  });
});
