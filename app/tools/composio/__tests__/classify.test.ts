import { describe, expect, it } from "vitest";
import { effectOf, needsApproval } from "../classify.js";

describe("effectOf", () => {
  it("reads readOnlyHint", () => {
    expect(effectOf(["readOnlyHint", "inbox"])).toBe("read");
  });

  it("reads destructiveHint", () => {
    expect(effectOf(["destructiveHint"])).toBe("destructive");
  });

  it("treats create and update as write", () => {
    expect(effectOf(["createHint"])).toBe("write");
    expect(effectOf(["updateHint"])).toBe("write");
  });

  it("prefers destructive when a tool carries both hints", () => {
    expect(effectOf(["readOnlyHint", "destructiveHint"])).toBe("destructive");
  });

  it("treats unknown, empty, and missing tags as write", () => {
    expect(effectOf(["important"])).toBe("write");
    expect(effectOf([])).toBe("write");
    expect(effectOf(undefined)).toBe("write");
  });
});

describe("needsApproval", () => {
  it("never asks when off", () => {
    expect(needsApproval("destructive", "off")).toBe(false);
    expect(needsApproval("write", "off")).toBe(false);
  });

  it("asks only for destructive by default", () => {
    expect(needsApproval("destructive", "destructive")).toBe(true);
    expect(needsApproval("write", "destructive")).toBe(false);
    expect(needsApproval("read", "destructive")).toBe(false);
  });

  it("asks for anything that is not a read when writes", () => {
    expect(needsApproval("destructive", "writes")).toBe(true);
    expect(needsApproval("write", "writes")).toBe(true);
    expect(needsApproval("read", "writes")).toBe(false);
  });
});
