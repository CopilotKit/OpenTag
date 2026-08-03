/**
 * `render_chart` — render Slack's native data visualization block directly
 * in the conversation. This is the "upload a CSV → get a chart" payoff: the
 * agent parses the data, then calls this with Slack's documented chart shape.
 */
import { z } from "zod";
import { defineChannelTool } from "@copilotkit/channels";
import { Slack } from "@copilotkit/channels/slack";

const shortLabel = z.string().min(1).max(20);
const dataPoint = z.object({
  label: shortLabel.describe(
    "X-axis category. Must match one axis_config.categories value.",
  ),
  value: z.number().finite().describe("Numeric y-axis value."),
});

const pieChart = z.object({
  type: z.literal("pie"),
  segments: z
    .array(
      z.object({
        label: shortLabel.describe("Slice label shown in the legend."),
        value: z.number().finite().positive().describe("Positive slice weight."),
      }),
    )
    .min(1)
    .max(12),
});

const seriesChart = z.object({
  type: z.enum(["bar", "area", "line"]),
  series: z
    .array(
      z.object({
        name: shortLabel.describe("Unique series name shown in the legend."),
        data: z.array(dataPoint).min(1).max(20),
      }),
    )
    .min(1)
    .max(12),
  axis_config: z.object({
    categories: z
      .array(shortLabel)
      .min(1)
      .max(20)
      .describe("Unique categories in left-to-right display order."),
    x_label: z.string().max(50).optional(),
    y_label: z.string().max(50).optional(),
  }),
});

const schema = z.object({
  title: z
    .string()
    .min(1)
    .max(50)
    .describe("Short title displayed above the chart."),
  chart: z
    .discriminatedUnion("type", [pieChart, seriesChart])
    .describe("Slack pie, bar, area, or line chart payload."),
}).superRefine(({ chart }, ctx) => {
  if (chart.type === "pie") return;

  const categories = chart.axis_config.categories;
  if (new Set(categories).size !== categories.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["chart", "axis_config", "categories"],
      message: "Category labels must be unique.",
    });
  }

  const seriesNames = chart.series.map(({ name }) => name);
  if (new Set(seriesNames).size !== seriesNames.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["chart", "series"],
      message: "Series names must be unique.",
    });
  }

  for (const [index, series] of chart.series.entries()) {
    const labels = series.data.map(({ label }) => label);
    const labelsMatchCategories =
      labels.length === categories.length &&
      new Set(labels).size === labels.length &&
      labels.every((label) => categories.includes(label));
    if (!labelsMatchCategories) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chart", "series", index, "data"],
        message:
          "Each series must contain exactly one data point for every axis category.",
      });
    }
  }
});

export const renderChartTool = defineChannelTool({
  name: "render_chart",
  description:
    "Render a native Slack data visualization in the conversation. Use this " +
    "after analyzing data such as an uploaded CSV. Supports pie, bar, area, " +
    "and line charts. Series data labels must exactly match the ordered axis " +
    "categories.",
  parameters: schema,
  async handler({ title, chart }, ctx) {
    if (ctx.platform !== "slack") {
      return "Chart render failed: native data visualizations are only available in Slack.";
    }

    try {
      await ctx.thread.post(
        <Slack.Block.DataVisualization title={title} chart={chart} />,
      );
      return "Rendered and posted the native Slack chart to the thread.";
    } catch (e) {
      console.error("[render-chart] native Slack render failed", e);
      return `Chart render failed: ${(e as Error).message}`;
    }
  },
});
