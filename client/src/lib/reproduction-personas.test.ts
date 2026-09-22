// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { REPRODUCTION_PERSONAS, reproductionPersonaName, useReproductionPrompts, type ReproductionPersona } from "./reproduction-personas";

const container = document.createElement("div");
let root = createRoot(container);
let current: ReturnType<typeof useReproductionPrompts>;
function Harness(props: { persona: ReproductionPersona; defaults?: { reproducerPrompt: string; judgePrompt: string } }) {
  current = useReproductionPrompts(props.persona, props.defaults);
  return createElement("span", null, current.reproducerPrompt);
}
function render(persona: ReproductionPersona, defaults?: { reproducerPrompt: string; judgePrompt: string }) {
  act(() => root.render(createElement(Harness, { persona, defaults })));
}
afterEach(() => { act(() => root.unmount()); root = createRoot(container); });

describe("reproduction persona prompt selection", () => {
  it("keeps both scientific and judge drafts separate across persona switches", () => {
    render("P", { reproducerPrompt: "P default", judgePrompt: "P judge" });
    act(() => { current.setReproducerPrompt("P custom"); current.setJudgePrompt("P custom judge"); });
    render("qP");
    expect(current.reproducerPrompt).toBe("");
    expect(current.judgePrompt).toBe("");
    render("qP", { reproducerPrompt: "qP default", judgePrompt: "qP judge" });
    expect(current.reproducerPrompt).toBe("qP default");
    act(() => { current.setReproducerPrompt("qP custom"); current.setJudgePrompt("qP custom judge"); });
    render("P");
    expect(current.reproducerPrompt).toBe("P custom");
    expect(current.judgePrompt).toBe("P custom judge");
    render("qP");
    expect(current.reproducerPrompt).toBe("qP custom");
    expect(current.judgePrompt).toBe("qP custom judge");
  });
  it("does not overwrite empty or custom drafts on late defaults; resets only the active draft", () => {
    render("qP");
    act(() => { current.setReproducerPrompt(""); current.setJudgePrompt("custom"); });
    render("qP", { reproducerPrompt: "arrived", judgePrompt: "judge arrived" });
    expect(current.reproducerPrompt).toBe("");
    expect(current.judgePrompt).toBe("custom");
    act(() => current.setReproducerPrompt(undefined));
    expect(current.reproducerPrompt).toBe("arrived");
    expect(current.judgePrompt).toBe("custom");
  });
  it("preserves historical P labels and explicitly describes automatic adaptation", () => {
    expect(reproductionPersonaName(undefined)).toBe("Reproduction Agent");
    expect(reproductionPersonaName("P")).toBe("Reproduction Agent");
    expect(reproductionPersonaName("qP")).toBe("Questioning Reproducer");
    expect(REPRODUCTION_PERSONAS.qP.description).toContain("automatically adapts working copies");
  });
});