/**
 * App-specific render components — agent-renderable Block Kit cards authored
 * with the umbrella `@copilotkit/channels` package's JSX vocabulary.
 *
 * Each component is a plain `ComponentFn` returning a `<Message>` tree; its
 * exported zod prop schema doubles as the render-tool input schema.
 */
export { IssueCard, issueCardSchema } from "./issue-card.js";
export type { IssueCardProps } from "./issue-card.js";

export { IssueList, issueListSchema } from "./issue-list.js";
export type { IssueListProps } from "./issue-list.js";

export { PageList, pageListSchema } from "./page-list.js";
export type { PageListProps } from "./page-list.js";
