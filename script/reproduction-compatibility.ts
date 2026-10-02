// Defaults to a no-network description. The paid branch requires explicit CLI consent.
const args = process.argv.slice(2);
if (!args.includes("--approve-model-charges")) {
  console.log("No model requests made. This benchmark uses real paid model calls with simulated local tools, never a GPU. To approve: npx tsx script/reproduction-compatibility.ts --approve-model-charges --model <managed-model-id> --repetitions 3");
} else {
  const { MANAGED_MODELS } = await import("../shared/model-catalog");
  const { runCompatibilityProbe } = await import("../server/reproduction-compatibility");
  const model = MANAGED_MODELS.find(m => m.model === args[args.indexOf("--model") + 1]);
  if (!model) throw new Error("Select an exact managed model ID using --model.");
  const repetitions = args.includes("--repetitions") ? Number(args[args.indexOf("--repetitions") + 1]) : 3;
  console.log(JSON.stringify(await runCompatibilityProbe({
    config: { providerMode: "platform", provider: model.provider, modelName: model.model },
    approveModelCharges: true, repetitions,
  }), null, 2));
}