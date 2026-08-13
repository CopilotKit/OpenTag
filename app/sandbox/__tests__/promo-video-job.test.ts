import { describe, expect, it } from "vitest";
import { formatMissingPromoVideoError } from "../promo-video-job.js";

describe("formatMissingPromoVideoError", () => {
  it("says Grok printed no text when the stream is empty", () => {
    expect(formatMissingPromoVideoError("")).toBe(
      "Promo video finished but out/video.mp4 was not found in the sandbox. Grok printed no text.",
    );
    expect(formatMissingPromoVideoError("   \n")).toBe(
      "Promo video finished but out/video.mp4 was not found in the sandbox. Grok printed no text.",
    );
  });

  it("includes the Grok tail so Slack shows why the render stopped", () => {
    const message = formatMissingPromoVideoError(
      "I could not find /hyperframes-video.\nStopped without rendering.",
    );
    expect(message).toContain(
      "Promo video finished but out/video.mp4 was not found in the sandbox.",
    );
    expect(message).toContain("Grok output (tail):");
    expect(message).toContain("I could not find /hyperframes-video.");
    expect(message).toContain("Stopped without rendering.");
  });

  it("surfaces PROMO_VIDEO_FAILED from the Grok text", () => {
    const message = formatMissingPromoVideoError(
      "working...\nPROMO_VIDEO_FAILED: ffmpeg missing libx264\nbye",
    );
    expect(message).toContain("PROMO_VIDEO_FAILED: ffmpeg missing libx264");
    expect(message).toContain("Grok output (tail):");
  });
});
