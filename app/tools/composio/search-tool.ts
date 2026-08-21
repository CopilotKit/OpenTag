/**
 * `search_my_tools` — the discovery half of the router.
 *
 * Binding every tool of every connected toolkit is not viable: gmail alone is
 * 63 tools, linear 47, googlecalendar 49. So the model searches instead, and
 * gets back a handful of candidates.
 *
 * Composio's search returns schemas in the same response, so this collapses
 * their search -> get_schemas -> execute into search -> execute, and the model
 * fills a real JSON schema rather than reconstructing one from prose.
 */
import { z } from "zod";
import { defineChannelTool, type ChannelTool, type ChannelToolContext } from "@copilotkit/channels";
import type { CachedSession } from "./sessions.js";

/** How many candidates the model sees. Tunable; not a principle. */
const MAX_RESULTS = 5;

/**
 * Which Composio sessions this turn may act through. An array, because one turn
 * can be both the shared team identity and the person who sent the message.
 */
export type ScopeResolver = (ctx: ChannelToolContext) => Promise<CachedSession[]>;

/** One candidate handed to the model. */
interface Candidate {
  slug: string;
  description: string;
  /** `null` when the response carried no schema — the model cannot call it. */
  inputSchema: unknown;
}

/**
 * The parts of the search response we read. Every field is optional in
 * practice, and the response itself may not be an object at all, so nothing
 * here is assumed present or well-typed.
 */
interface SearchResponse {
  results?: unknown;
  toolSchemas?: unknown;
  toolkitConnectionStatuses?: unknown;
}

interface ToolSchema {
  description?: unknown;
  inputSchema?: unknown;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStrings(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string");
}

/** Every candidate one scope offers, in the order that scope ranked them. */
function candidatesOf(response: SearchResponse): Candidate[] {
  const schemas = asRecord(response.toolSchemas);
  const candidates: Candidate[] = [];

  for (const entry of asArray(response.results)) {
    const result = asRecord(entry);
    // Primary slugs before related ones: that is the scope's own ranking.
    const slugs = [...asStrings(result.primaryToolSlugs), ...asStrings(result.relatedToolSlugs)];
    for (const slug of slugs) {
      const schema = asRecord(schemas[slug]) as ToolSchema;
      candidates.push({
        slug,
        description: typeof schema.description === "string" ? schema.description : "",
        inputSchema: schema.inputSchema ?? null,
      });
    }
  }

  return candidates;
}

/**
 * Round-robin across the scopes rather than concatenating them.
 *
 * Scopes arrive workspace-first, and the cap is global. Concatenating would let
 * a chatty shared scope fill all five slots and make the requesting person's own
 * apps unreachable — "what's on my calendar" answering with only Linear tools.
 * Taking one candidate from each scope in turn keeps every scope represented.
 *
 * Deduplicated by slug, first occurrence wins. Linear scan on purpose: n is a
 * handful, and a Set would buy nothing here.
 */
function interleave(perScope: Candidate[][]): Candidate[] {
  const merged: Candidate[] = [];
  const deepest = perScope.reduce((max, list) => Math.max(max, list.length), 0);

  for (let rank = 0; rank < deepest; rank++) {
    for (const list of perScope) {
      const candidate = list[rank];
      if (!candidate) continue;
      if (merged.some((t) => t.slug === candidate.slug)) continue;
      merged.push(candidate);
    }
  }

  return merged;
}

export function createSearchTool(resolve: ScopeResolver): ChannelTool {
  return defineChannelTool({
    name: "search_my_tools",
    description:
      "Find actions available in the connected apps. Call this before run_my_tool. " +
      "Returns tool slugs with their input schemas.",
    parameters: z.object({
      query: z.string().describe("What you want to do, in plain words, e.g. 'send an email'"),
    }),
    async handler({ query }, ctx) {
      const scopes = await resolve(ctx);
      if (scopes.length === 0) return "Connected apps are not configured for you.";

      // One round trip per scope, in parallel. `allSettled` so a scope whose
      // session is broken costs only its own candidates, not everyone else's.
      const settled = await Promise.allSettled(
        scopes.map((scope) => scope.session.search({ query })),
      );

      const perScope: Candidate[][] = [];
      const needsConnection: string[] = [];

      for (const outcome of settled) {
        if (outcome.status !== "fulfilled") continue;
        const response = asRecord(outcome.value) as SearchResponse;

        perScope.push(candidatesOf(response));

        // Only an explicit `false` means "not connected" — an absent status is
        // silence, not something to prompt the user about.
        for (const entry of asArray(response.toolkitConnectionStatuses)) {
          const status = asRecord(entry);
          if (status.hasActiveConnection !== false) continue;
          if (typeof status.toolkit !== "string") continue;
          if (!needsConnection.includes(status.toolkit)) needsConnection.push(status.toolkit);
        }
      }

      // A schema-less candidate is uncallable, so it must never displace a
      // callable one — but it still ships, so the model can see the tool exists.
      const merged = interleave(perScope);
      const tools = [
        ...merged.filter((t) => t.inputSchema !== null),
        ...merged.filter((t) => t.inputSchema === null),
      ];

      return { tools: tools.slice(0, MAX_RESULTS), needsConnection };
    },
  });
}
