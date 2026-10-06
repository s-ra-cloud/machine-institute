import { ReproductionReadGuard } from "./reproduction-read-guard";

/** Planning-local navigation, not scientific progress and never a renewed budget. */
export class PlanningRecovery {
  private guard = new ReproductionReadGuard();
  private repeats = 0;
  private references = new Map<string, number>();
  private directories = new Map<string, string>();
  firstStallCall?: number;

  observe(name: string, result: string, id: number, stageCalls: number): void {
    const before = this.guard.pagingDiagnostics;
    const directory = /^Verified directory: ([^\n]+)\n/.exec(result);
    const file = /^Verified file: ([^\n]+)\nReturned characters: (\d+)-(\d+)/.exec(result);
    // The guard's warning text is intentionally discarded: its old instructions
    // request record_result, which is not a planning tool.
    this.guard.observe(name, result, { acceptedClaims: 1, assessed: false }, id);
    const after = this.guard.pagingDiagnostics;
    const key = file ? `${file[1]}:${file[2]}-${file[3]}` : directory?.[1];
    if (key && !this.references.has(key)) this.references.set(key, id);
    this.repeats += after.sourceRepeatCount - before.sourceRepeatCount
      + after.outputRepeatCount - before.outputRepeatCount;
    if (directory) {
      if (this.directories.get(directory[1]) === result) this.repeats++;
      this.directories.set(directory[1], result);
    }
    if (this.firstStallCall === undefined && (this.repeats >= 2 || stageCalls >= 6))
      this.firstStallCall = stageCalls;
  }

  instruction(remaining: number, globalRemaining: number, qp: boolean): string {
    return `${this.firstStallCall === undefined ? "PLANNING" : "PLANNING REPAIR"}: ${remaining} stage calls, ${globalRemaining} global calls remain. ${remaining <= 4 ? "Navigation is closed: commit a grounded provisional plan now; execution can inspect further and revise it. A plan is NOT a scientific verdict. " : "Inspect only enough relevant shipped script/data to design the experiment; do not exhaustively read source or prepare execution here. "}Do not repeat README/list orientation. Submit_plan with this packet's exact claimId, inspected paths, measurement and rationale. ${qp ? "qP: assess_suitability is required before submit_plan; no execution or edits here. " : ""}Never invent values or blockers; an unsupported plan must fail honestly.`;
  }

  state() {
    return { firstStallCall: this.firstStallCall,
      inspected: Array.from(this.references, ([range, id]) => ({ range, id })).slice(-6) };
  }
}