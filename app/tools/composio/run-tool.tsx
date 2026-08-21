/**
 * `run_my_tool` — the execution half of the router, and the approval gate.
 *
 * Composio's hosted executor would send the call from the model straight to
 * Composio, bypassing this file and therefore bypassing approval. That is the
 * whole reason this wrapper exists.
 *
 * Managed Channels cannot block on a choice, so a gated call posts a card and
 * ends the turn; the button handler executes and rewrites the card. The model
 * therefore never sees a gated call's result — acceptable while `destructive` is
 * the default, since the gated case is deletes.
 */
import { z } from "zod";
import {
  defineChannelTool,
  type ChannelTool,
  type InteractionContext,
} from "@copilotkit/channels";
import type { ApprovalMode } from "./config.js";
import { needsApproval, type Effect } from "./classify.js";
import type { ScopeResolver } from "./search-tool.js";
import type { CachedSession } from "./sessions.js";
import { mayApprove, registerPending, restorePending, takePending } from "./pending.js";
import {
  ConfirmToolRun,
  ToolRunOutcome,
  toolRunFields,
  type ConfirmDecision,
} from "../../human-in-the-loop/index.js";

/**
 * What a slug the effect map has never heard of is treated as.
 *
 * Not `"write"`. The map is filled from `getRawComposioTools({ limit: 300 })`,
 * so a real slug past that cap is unmapped through no fault of the model — and
 * a hallucinated or prompt-injected slug is unmapped too. `needsApproval(
 * "write", "destructive")` is `false`, so calling any of those a write would
 * run them unapproved in the mode that ships by default. Gated everywhere but
 * `off` is the only reading of "unrecognised" that is actually fail-safe.
 *
 * A slug that IS classified and merely isn't read-only stays a write.
 */
const UNMAPPED_EFFECT: Effect = "destructive";

/**
 * Does this scope own the toolkit the slug belongs to?
 *
 * Composio slugs are `TOOLKIT_REST_OF_NAME` with the toolkit uppercased —
 * `GMAIL_SEND_EMAIL`, `GOOGLECALENDAR_EVENTS_LIST` — so the prefix is the only
 * thing needed to place a slug the effect map never saw. Which is the case that
 * matters: the map is filled with `limit: 300`, and a real slug past that cap
 * would otherwise fall to `scopes[0]`, the shared account, which does not carry
 * the toolkit at all.
 */
function ownsSlug(scope: CachedSession, slug: string): boolean {
  const upper = slug.toUpperCase();
  return scope.toolkits.some((toolkit) => upper.startsWith(`${toolkit.toUpperCase()}_`));
}

/** `GMAIL_SEND_EMAIL` -> `Gmail send email`. */
function actionLabel(slug: string): string {
  const words = slug.toLowerCase().split("_").filter(Boolean);
  if (words.length === 0) return slug;
  return [words[0]![0]!.toUpperCase() + words[0]!.slice(1), ...words.slice(1)].join(" ");
}

/**
 * One line per Composio call. Slug, effect, resolved identity and Composio's own
 * `logId` — enough to correlate with their dashboard, and deliberately nothing
 * from `args`, which is where the credentials and the mail bodies are.
 */
function logLine(
  slug: string,
  effect: Effect,
  userId: string,
  logId: string | undefined,
  ok: boolean,
) {
  console.log(
    `[composio] ${slug} ${ok ? "ok" : "failed"} effect=${effect} user=${userId} log=${logId ?? "none"}`,
  );
}

/**
 * The Approve/Cancel click on a `ConfirmToolRun` card.
 *
 * Lifted out of the JSX because this, not the tool handler, is where the
 * security decisions live: an expired token, the wrong person clicking, and a
 * provider failure that arrives as a resolved value rather than a throw. A
 * closure inside the card is unreachable from a test; an exported function is
 * not.
 *
 * `cardAction` is the label the card was posted with. It is used only when no
 * pending call can be recovered — every other branch reports `call.action`, the
 * label of the call actually being decided.
 */
export async function handleToolRunDecision(
  interaction: InteractionContext<ConfirmDecision>,
  cardAction: string,
): Promise<void> {
  const decision = interaction.action.value;
  // No value at all is not this card's button; there is nothing to report.
  if (!decision) return;

  // An empty token names no call, so it gets the same answer as a token whose
  // call is gone. Returning silently would leave a live card and no feedback.
  const call = decision.token ? takePending(decision.token) : undefined;
  if (!call) {
    await interaction.thread.update(
      interaction.message.ref,
      <ToolRunOutcome
        action={cardAction}
        text="This approval expired — the bot restarted. Ask again."
        ok={false}
      />,
    );
    return;
  }

  if (!mayApprove(call, interaction.actor?.id)) {
    // The wrong person clicked; the request still stands. Restored under the
    // same token, before any await, so the live card keeps working and no
    // second click can slip into the gap. The card is not rewritten either —
    // that would strip the buttons the rightful approver needs.
    restorePending(decision.token, call);
    await interaction.thread.post(`Only the person who asked can approve **${call.action}**.`);
    return;
  }

  // Anything other than an explicit approval is a decline. The token is already
  // consumed, so a declined card cannot be clicked into a run.
  if (decision.approved !== true) {
    await interaction.thread.update(
      interaction.message.ref,
      <ToolRunOutcome action={call.action} text="Cancelled. Nothing was changed." ok={false} />,
    );
    return;
  }

  // Two ways this fails. `execute` resolves with an `error` when the tool
  // itself rejects the call, and throws when the transport does — a timeout, a
  // dead session. The token is already consumed either way, so a throw that
  // escaped here would leave the card frozen with no result and no way back.
  let logId: string | undefined;
  let failure: string | undefined;
  try {
    const result = await call.session.execute(call.slug, call.args);
    logId = result?.logId;
    failure = result?.error ?? undefined;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  logLine(call.slug, call.effect, call.userId, logId, !failure);

  await interaction.thread.update(
    interaction.message.ref,
    <ToolRunOutcome
      action={call.action}
      text={failure ? `Failed — ${failure}` : "Done."}
      ok={!failure}
    />,
  );
}

export function createRunTool(
  resolve: ScopeResolver,
  mode: ApprovalMode,
  workspaceUserId: string,
): ChannelTool {
  return defineChannelTool({
    name: "run_my_tool",
    description:
      "Run one action found with search_my_tools. Pass the exact slug and arguments " +
      "matching that tool's input schema.",
    parameters: z.object({
      slug: z.string().describe("Exact tool slug, e.g. GMAIL_SEND_EMAIL"),
      args: z.record(z.unknown()).describe("Arguments matching the tool's input schema"),
    }),
    async handler({ slug, args }, ctx) {
      const scopes = await resolve(ctx);
      if (scopes.length === 0) return "Connected apps are not configured for you.";

      // Route to the scope that knows this slug, then to the scope that owns
      // its toolkit, and only then to the first. The middle step is not a
      // nicety: scopes arrive workspace-first, so without it an unmapped
      // personal slug runs against the shared session — which cannot execute it
      // — and its approval card binds to `workspaceUserId`, making one person's
      // action approvable by anyone in the thread. The final fallback stands so
      // a slug belonging to nothing still produces a real provider error rather
      // than silence.
      const scope =
        scopes.find((s) => s.effects.has(slug)) ??
        scopes.find((s) => ownsSlug(s, slug)) ??
        scopes[0]!;
      const effect: Effect = scope.effects.get(slug) ?? UNMAPPED_EFFECT;
      const action = actionLabel(slug);
      // The identity of the scope the slug routed to, not the actor's. They
      // differ whenever a person's message runs through the shared workspace
      // account, and it is the account being touched that decides who may
      // approve — a shared one belongs to the thread, a personal one to its
      // owner.
      const userId = scope.userId;

      if (needsApproval(effect, mode)) {
        const token = registerPending({
          session: scope.session,
          slug,
          args,
          effect,
          userId,
          workspaceUserId,
          action,
        });

        await ctx.thread.post(
          <ConfirmToolRun
            action={action}
            fields={toolRunFields(args)}
            destructive={effect === "destructive"}
            token={token}
          />,
        );

        return (
          `Posted an approval card for ${action}. Stop here — do not retry or ` +
          "explain. The result is reported on the card."
        );
      }

      const result = await scope.session.execute(slug, args);

      // execute() does NOT throw on tool failure. A try/catch alone would treat
      // every failed write as a success.
      if (result?.error) {
        logLine(slug, effect, userId, result.logId, false);
        return `Tool ${slug} failed: ${result.error}`;
      }

      logLine(slug, effect, userId, result?.logId, true);
      return result?.data ?? null;
    },
  });
}
