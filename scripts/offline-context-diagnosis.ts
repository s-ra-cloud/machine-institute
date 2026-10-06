// Offline only: no provider client, network calls, or sandbox allocation.
import assert from "node:assert/strict";
import { RequestContextBudget } from "../server/llm-context";
import { fitToolContext } from "../server/tool-context";

const budget = new RequestContextBudget(
  { providerMode: "byoc", provider: "openai", modelName: "gpt-4o" }, 8000, "tool-loop", 32768,
);
budget.inputLimit = 2000;
const call = (id: string, name: string) => ({
  role: "assistant", content: "", tool_calls: [
    { id, type: "function", function: { name, arguments: "{}" } },
  ],
});
const measurement = "NEW_EXPERIMENT_OUTPUT score=0.91";
const request = {
  messages: [
    { role: "system", content: "Retain scientific evidence; never infer reproduction from inspection." },
    { role: "user", content: "Execute the accepted experiment." },
    call("old-retrieval", "read_tool_result"),
    { role: "tool", tool_call_id: "old-retrieval", content: "[Tool call #1]\n" + "old inspected source ".repeat(2000) },
    call("new-command", "run_command"),
    { role: "tool", tool_call_id: "new-command", content: `[Tool call #2]\n${measurement}` },
  ],
};
const canonical = JSON.stringify(request);
const fitted = fitToolContext(request, {
  budget, protection: { getState: () => "Execution: pending claim R1." },
});
const repaired = fitToolContext(request, {
  budget, protection: { getState: () => "Execution: pending claim R1.", preserveLatestToolBatch: true },
});
assert(JSON.stringify(repaired).includes(measurement), "Protected fitting must retain the fresh measurement.");
assert(budget.fits(repaired), "Repaired fitting must still respect the hard bound.");
assert.equal(JSON.stringify(request), canonical, "Canonical evidence must not be mutated.");
assert(budget.fits(fitted), "Probe must respect the context bound.");
console.log(JSON.stringify({
  offline: true,
  canonicalMeasurementPresent: canonical.includes(measurement),
  fittedMeasurementPresent: JSON.stringify(fitted).includes(measurement),
  protectedMeasurementPresent: JSON.stringify(repaired).includes(measurement),
  newestToolResult: fitted.messages.find(m => m.tool_call_id === "new-command")?.content ?? null,
}, null, 2));
