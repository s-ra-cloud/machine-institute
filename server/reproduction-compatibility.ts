import { extractReproductionClaims } from "./reproduction-extraction";
import { runBatchReproduction } from "./reproduction-batch";
import { ReproductionSession } from "./reproduction-session";
import { getReproductionClaimIssues, REPRODUCTION_TOOLS } from "./reproduce";
import type { ModelProviderConfig } from "./model-service";
import { diagnosticExcerpt } from "./reproduction-diagnostics";

/**
 * Opt-in real-model compatibility measurement. No sandbox, shell, publication,
 * dataset download or GPU exists here. API usage is still paid by the caller.
 */
export async function runCompatibilityProbe(input: {
  config: ModelProviderConfig; approveModelCharges: boolean; repetitions: number;
}) {
  if (input.approveModelCharges !== true) throw new Error("Explicit approval of model API charges is required.");
  if (!Number.isInteger(input.repetitions) || input.repetitions < 1 || input.repetitions > 5) throw new Error("Choose 1–5 repetitions.");
  const samples: Array<{ passed: boolean; stages: string[]; calls: number; failure?: string }> = [];
  const paper = "In this synthetic compatibility fixture, the measured arithmetic mean is 2.";
  const instructions = "This is a synthetic software compatibility test, not scientific reproduction. Plan one rerun experiment of /work/materials/fixture.py, measuring an arithmetic mean; the application executes python /work/materials/fixture.py itself. Do not write scripts or install dependencies. When asked to assess, record the exact measured output as verified with method rerun. No sandbox exists. Paper extraction still requires exact quotations.";
  for (let attempt = 0; attempt < input.repetitions; attempt++) {
    const sample: typeof samples[number] = { passed: false, stages: [], calls: 0 };
    const deadline = Date.now() + 120000;
    try {
      const extracted = await extractReproductionClaims({ config: input.config, paper, instructions, deadline });
      sample.stages.push("extraction"); sample.calls = extracted.calls;
      const session = new ReproductionSession((recordedResults, toolCalls) => getReproductionClaimIssues({ recordedResults, toolCalls }));
      session.configureSourceGrounding({ paperPath: "/work/paper.md", paperText: paper });
      extracted.claims.forEach(c => session.registerExtractedClaim(c));
      await runBatchReproduction({
        config: input.config, instructions, session, tools: REPRODUCTION_TOOLS,
        shippedPaths: new Set(["/work/materials/fixture.py", "/work/materials/README.md"]), extractionCalls: extracted.calls,
        inventoryPath: "/work/MATERIALS_INDEX.md", readmePaths: ["/work/materials/README.md"],
        execute: async (name, args) => {
          let result: string;
          if (name === "run_command") result = args.command === "python /work/materials/fixture.py"
            ? "exit code 0\nsynthetic_mean=2" : "Refused: only the declared fixture entrypoint is simulated.";
          else if (name === "record_result") result = session.recordResult(args);
          else if (name === "read_tool_result") result = session.readToolResult(args);
          else if (name === "read_file" && args.path === "/work/materials/fixture.py") result = "Verified file: /work/materials/fixture.py\nReturned characters: 0-24 of 24\n---\nprint(sum([1, 2, 3]) / 3)";
          else if (name === "read_file" && args.path === "/work/MATERIALS_INDEX.md") result = "Verified file: /work/MATERIALS_INDEX.md\nReturned characters: 0-60 of 60\n---\n- /work/materials/fixture.py\n- /work/materials/README.md";
          else if (name === "read_file" && args.path === "/work/materials/README.md") result = "Verified file: /work/materials/README.md\nReturned characters: 0-50 of 50\n---\nRun python fixture.py to print the synthetic mean.";
          else if (name === "list_files") result = `Verified directory: ${String(args.path ?? "/work")}\nf fixture.py\nf README.md`;
          else result = "Refused: this compatibility fixture exposes only synthetic data and execution.";
          session.captureOutput(name, result); return result;
        },
        options: { deadlineMs: deadline, maxToolCalls: 24, maxTokens: 2000, numberToolResults: true,
          onToolCall: rec => { sample.calls++; } },
        checkpoint: async state => { if (!sample.stages.includes(state.controller.phase)) sample.stages.push(state.controller.phase); },
      });
      sample.passed = Array.from(session.recorded.values()).every(c => c.status === "verified");
    } catch (error) { sample.failure = diagnosticExcerpt(error instanceof Error ? error.message : String(error), 500); }
    samples.push(sample);
  }
  return { mode: "real-model/simulated-tools", model: input.config.modelName, provider: input.config.provider,
    gpuRuns: 0, samples, successRate: samples.filter(s => s.passed).length / samples.length,
    stagePassRates: Object.fromEntries(["extraction", "planning", "execution", "assessment", "judging"]
      .map(stage => [stage, samples.filter(s => s.stages.includes(stage)).length / samples.length])),
    cost: "Model API usage was billable. Actual monetary cost is not returned by this adapter; consult the selected provider billing record. No GPU costs." };
}