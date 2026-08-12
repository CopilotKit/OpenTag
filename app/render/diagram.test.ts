import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const png = Buffer.from("styled-diagram");
  const screenshot = vi.fn(async () => png);
  const renderPage = {
    setContent: vi.fn(async (_html: string) => undefined),
    addScriptTag: vi.fn(async (_options: { url: string }) => undefined),
    evaluate: vi.fn(async (_callback: unknown, _code: string) => ({
      svg: "<svg><text>Flow</text></svg>",
    })),
    close: vi.fn(async () => undefined),
  };
  const shotPage = {
    setContent: vi.fn(async (_html: string, _options?: unknown) => undefined),
    evaluate: vi.fn(async (_callback: unknown) => undefined),
    $: vi.fn(async (_selector: string) => ({ screenshot })),
    close: vi.fn(async () => undefined),
  };
  const browser = {
    newPage: vi
      .fn(
        async (_options?: unknown) =>
          renderPage as typeof renderPage | typeof shotPage,
      )
      .mockResolvedValueOnce(renderPage)
      .mockResolvedValueOnce(shotPage),
  };
  return { browser, png, renderPage, screenshot, shotPage };
});

vi.mock("./browser.js", () => ({
  getBrowser: vi.fn(async () => mocks.browser),
}));

const { renderDiagram } = await import("./diagram.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.browser.newPage
    .mockResolvedValueOnce(mocks.renderPage)
    .mockResolvedValueOnce(mocks.shotPage);
});

describe("renderDiagram visual treatment", () => {
  it("applies the CopilotKit Mermaid theme and screenshots a branded frame", async () => {
    const result = await renderDiagram("flowchart LR\n A --> B");

    expect(result).toBe(mocks.png);
    const evaluate = mocks.renderPage.evaluate.mock.calls[0]?.[0];
    expect(String(evaluate)).toContain('theme: "base"');
    expect(String(evaluate)).toContain('fontFamily: "Arial, sans-serif"');
    expect(String(evaluate)).toContain('primaryTextColor: "#010507"');
    expect(String(evaluate)).toContain(
      'primaryColor: "rgba(255, 172, 77, 0.2)"',
    );
    expect(String(evaluate)).toContain('secondaryColor: "#F3F3FC"');
    expect(String(evaluate)).toContain(
      'tertiaryColor: "rgba(255, 243, 136, 0.3)"',
    );
    expect(String(evaluate)).toContain('lineColor: "#57575b"');

    const shotHtml = mocks.shotPage.setContent.mock.calls[0]?.[0] as string;
    expect(shotHtml).toContain("#dedee9");
    expect(shotHtml).toContain("rgba(255, 255, 255, 0.7)");
    expect(shotHtml).toContain('font-family:"Plus Jakarta Sans"');
    expect(shotHtml).toContain("filter:blur(103px)");
    expect(mocks.shotPage.$).toHaveBeenCalledWith("#frame");
  });
});
