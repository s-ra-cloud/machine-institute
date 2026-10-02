/** Run-local allowances, never evidence of scientific success. Global limits win. */
export class ReproductionRecovery {
  stage: "preparation" | "analysis" | "finalization" = "preparation";
  private start = 0;
  private started = false;
  private analysisUsed = false;
  begin(count: number) { this.started = true; this.start = count; }
  remaining(count: number) {
    return Math.max(0, this.limit - (count - this.start));
  }
  private get limit() { return this.stage === "preparation" ? 4 : this.stage === "analysis" ? 6 : 3; }
  observe(count: number, name: string, output: string, error?: boolean) {
    if (this.started && this.stage === "preparation" && !this.analysisUsed
      && name === "run_command" && !error && /^exit code \d+/m.test(output)) {
      // Includes genuine nonzero exits so dependency failures can be assessed.
      // Printing a supplied CSV earns bounded analysis time, NOT verification.
      this.analysisUsed = true;
      this.stage = "analysis";
      this.start = count;
    }
  }
  advance(count: number) {
    if (this.started && this.remaining(count) === 0 && this.stage !== "finalization") {
      this.stage = "finalization";
      this.start = count;
    }
  }
  allows(name: string) {
    return this.stage !== "finalization"
      || ["record_result", "read_tool_result", "read_reproduction_context", "assess_suitability"].includes(name);
  }
}