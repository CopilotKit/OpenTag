/**
 * `page_list` — renders Notion page search results as a Block Kit card:
 * a header, then one row per page (📄 linked title + a greyed snippet and
 * optional last-edited), with dividers and a count footer.
 *
 * Each page row renders as its own section (+ optional context + divider),
 * so a long list produces many blocks — unlike `issue_list`, which folds
 * every issue into a single fixed section. To avoid blowing past Slack's
 * per-attachment block limit (and getting the whole message rejected with
 * `invalid_attachments`), we cap the rendered rows at `MAX` and surface the
 * overflow in the footer, mirroring `issue-list.tsx`'s approach.
 *
 * The agent searches Notion via MCP and passes the pages it wants to
 * surface; the Slack formatting lives here.
 *
 * Authored with the `@copilotkit/channels` JSX vocabulary.
 */
import { z } from "zod";
import {
  Context,
  Divider,
  Header,
  Message,
  Section,
  type ChannelNode,
} from "@copilotkit/channels";
import { ACCENT } from "./_status.js";

const pageSchema = z.object({
  title: z.string().describe("Page title."),
  url: z.string().optional().describe("Link to the page in Notion."),
  snippet: z
    .string()
    .optional()
    .describe("A short excerpt or summary of the page."),
  editedBy: z.string().optional().describe("Who last edited it, if known."),
  edited: z
    .string()
    .optional()
    .describe("Human-readable last-edited, e.g. '3d ago'."),
});

export const pageListSchema = z.object({
  heading: z
    .string()
    .optional()
    .describe("Optional heading, e.g. 'Runbooks matching “auth outage”'."),
  pages: z.array(pageSchema).min(1).describe("The pages to render."),
});

export type PageListProps = z.infer<typeof pageListSchema>;
type Page = z.infer<typeof pageSchema>;

/** Max pages rendered inline; the rest are summarized in the footer. */
const MAX = 15;

/** Render a list of Notion pages as a Block Kit card. */
export function PageList({ heading, pages }: PageListProps): ChannelNode {
  const shown = pages.slice(0, MAX);
  const rows: ChannelNode[] = [];
  shown.forEach((page: Page, i: number) => {
    const titleLink = page.url
      ? `[**${page.title}**](${page.url})`
      : `**${page.title}**`;

    // `edited` and `editedBy` are independent schema fields — an agent may
    // supply either one without the other, so compose them rather than
    // gating the whole line on `edited` being present.
    const editedLine =
      page.edited || page.editedBy
        ? `🕒 edited${page.edited ? ` ${page.edited}` : ""}${page.editedBy ? ` by ${page.editedBy}` : ""}`
        : null;

    const meta = [page.snippet, editedLine].filter(Boolean).join("\n");

    rows.push(<Section>{`📄  ${titleLink}`}</Section>);
    if (meta) rows.push(<Context>{meta}</Context>);
    if (i < shown.length - 1) rows.push(<Divider />);
  });

  const footer =
    pages.length > MAX
      ? `Showing ${MAX} of ${pages.length} pages`
      : `${pages.length} page${pages.length === 1 ? "" : "s"}`;

  return (
    <Message accent={ACCENT.notion}>
      <Header>{`📚  ${heading ?? "Notion pages"}`}</Header>
      {rows}
      <Context>{footer}</Context>
    </Message>
  );
}
