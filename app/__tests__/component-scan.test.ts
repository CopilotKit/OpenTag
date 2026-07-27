import { describe, it, expect } from "vitest";
import { interactiveComponentNames } from "./component-scan.js";

describe("interactiveComponentNames", () => {
  it("finds a component declared with `export function`", () => {
    const src = `
export function ConfirmWrite({ action }: Props) {
  return <Button onClick={async () => {}}>Create</Button>;
}
`;
    expect(interactiveComponentNames(src)).toEqual(["ConfirmWrite"]);
  });

  it("finds a component declared with `export const` and an arrow", () => {
    // THE GAP: the original scan only matched `export function`, so an
    // interactive card written this way was never required to be registered.
    const src = `
export const QuickReply = ({ label }: Props) => (
  <Button onClick={async () => {}}>{label}</Button>
);
`;
    expect(interactiveComponentNames(src)).toEqual(["QuickReply"]);
  });

  it("returns nothing for a file with no onClick", () => {
    const src = `
export function StatusCard({ heading }: Props) {
  return <Section>{heading}</Section>;
}
`;
    expect(interactiveComponentNames(src)).toEqual([]);
  });

  it("attributes an onClick to its own declaration, not a later sibling", () => {
    const src = `
export function IncidentCard({ id }: Props) {
  return <Button onClick={async () => {}}>{id}</Button>;
}

export function StatusCard({ heading }: Props) {
  return <Section>{heading}</Section>;
}
`;
    expect(interactiveComponentNames(src)).toEqual(["IncidentCard"]);
  });

  it("finds every interactive declaration in a file", () => {
    const src = `
export function CardA() {
  return <Button onClick={async () => {}}>a</Button>;
}

export const CardB = () => <Button onClick={async () => {}}>b</Button>;
`;
    expect(interactiveComponentNames(src)).toEqual(["CardA", "CardB"]);
  });
});
