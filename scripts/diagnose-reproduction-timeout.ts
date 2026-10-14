/** Opt-in diagnostic, not a reproduction verdict. Runs the unmodified shipped analysis with observability only. */
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync, renameSync } from "node:fs";
import { fetchContributionMaterials, materialSandboxPath } from "../server/fs-materials";
import { ReproductionSandbox } from "../server/modal-sandbox";
import { createSpendingGuard } from "./live-reproduction-budget";

async function main() {
  if (process.env.RUN_LIVE_REPRODUCTION !== "1") throw new Error("Explicit paid-run opt-in required.");
  const root = ".local/state/live-reproduction";
  const lockPath = `${root}/website.lock`;
  const lock = openSync(lockPath, "wx");
  const path = `${root}/diagnostic-${Date.now()}`;
  mkdirSync(path, { recursive: true });
  let sandbox: ReproductionSandbox | undefined;
  try {
    const materials = await fetchContributionMaterials("yy1xhmskst8o5blht5gbipmi");
    const source = materials.files.find(f => f.name === "analysis3_early_state_patching.py");
    if (!source?.text || source.truncated) throw new Error("Complete source required.");
    writeFileSync(`${path}/source.py`, source.text);
    const ledgerPath = `${root}/budget.json`;
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    createSpendingGuard(stop => console.error(JSON.stringify(stop))).check("Modal", ledger.modalReserved, 5, 10);
    ledger.modalReserved += 5;
    writeFileSync(`${ledgerPath}.tmp`, JSON.stringify(ledger, null, 2));
    renameSync(`${ledgerPath}.tmp`, ledgerPath);
    const env: Record<string, string> = { PYTHONUNBUFFERED: "1", MPLBACKEND: "Agg", TOKENIZERS_PARALLELISM: "false" };
    if (process.env.HF_TOKEN) env.HF_TOKEN = process.env.HF_TOKEN;
    sandbox = await ReproductionSandbox.create({ gpu: "A10G", timeoutMs: 1800000, env, resourceLimits: { cpu: 2, memoryMiB: 8192 } });
    writeFileSync(`${path}/sandbox.json`, JSON.stringify({ sandboxId: sandbox.sandboxId }));
    for (const file of materials.files) {
      if (file.kind === "text" && file.text && file.source !== "paper")
        await sandbox.writeText(materialSandboxPath(file), file.text);
    }
    await sandbox.writeText("/work/diagnose.py", `
import importlib.util, sys, time, resource, faulthandler, pathlib
faulthandler.dump_traceback_later(60, repeat=True)
spec = importlib.util.spec_from_file_location("diagnostic_analysis", "/work/materials/analysis3_early_state_patching.py")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
original = module.run_prompt
count = 0
started = time.monotonic()
def instrumented(*args, **kwargs):
    global count
    before = time.monotonic()
    result = original(*args, **kwargs)
    count += 1
    memory = {}
    for filename in ("memory.current", "memory.max", "memory.events", "memory.swap.current"):
        p = pathlib.Path("/sys/fs/cgroup") / filename
        if p.exists(): memory[filename] = p.read_text().strip()
    print("DIAGNOSTIC", {"prompts": count, "seconds": round(time.monotonic()-before, 2), "elapsed": round(time.monotonic()-started, 2), "max_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, "cgroup": memory}, flush=True)
    return result
module.run_prompt = instrumented
module.main()
`);
    console.log(JSON.stringify({ event: "diagnostic-start", path, sandboxId: sandbox.sandboxId }));
    const result = await sandbox.exec(["python", "/work/diagnose.py"], { timeoutMs: 900000 });
    writeFileSync(`${path}/result.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    try {
      if (sandbox) {
        await sandbox.terminate();
        writeFileSync(`${path}/terminated.json`, JSON.stringify({ at: new Date().toISOString() }));
        console.log("Diagnostic sandbox terminated.");
      }
    } finally { closeSync(lock); unlinkSync(lockPath); }
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Diagnostic failed"); process.exitCode = 1; });
