import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { isolatedQuestioningCommand, QUESTIONING_LINK_SNAPSHOT_SCRIPT } from "../reproduction-isolation";

let nixEntries: string[] | undefined;
function executable(standard: string, fragment: string, name: string) {
  if (existsSync(standard)) return standard;
  if (!existsSync("/nix/store")) return undefined;
  nixEntries ??= readdirSync("/nix/store");
  const entry = nixEntries.find(p => p.includes(fragment) && existsSync(`/nix/store/${p}/bin/${name}`)
    && (name !== "python3" || spawnSync(`/nix/store/${p}/bin/${name}`, ["--version"], { env: {}, timeout: 2000 }).status === 0));
  return entry ? `/nix/store/${entry}/bin/${name}` : undefined;
}
const bwrap = executable("/usr/bin/bwrap", "bubblewrap-0.11.", "bwrap");
const python = executable("/usr/bin/python3", "python3-3.11.", "python3");
const supported = process.platform === "linux" && Boolean(bwrap && python);
// Real Linux subprocesses, not mocks. Availability is explicit for other CI OSes.
describe.skipIf(!supported)("qP real adversarial namespace boundary", () => {
  let root: string, source: string, dependencies: string, hostilePath: string;
  const marker = "qp-adversarial-secret-never-exposed";
  const roots = ["/usr", "/bin", "/lib", "/lib64", ...(existsSync("/nix/store") ? ["/nix/store"] : [])].filter(existsSync);
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "qp-isolation-"));
    source = join(root, "source"); dependencies = join(root, "dependencies"); hostilePath = join(root, "hostile-pythonpath");
    for (const path of [source, dependencies, hostilePath]) mkdirSync(path);
    chmodSync(dependencies, 0o777); // Reproduce the former dangerous host permissions.
    mkdirSync(join(source, "materials"));
    writeFileSync(join(dependencies, "approved.py"), "VALUE = 'approved immutable dependency'\n");
    writeFileSync(join(hostilePath, "sitecustomize.py"), "raise RuntimeError('HOST_SITECUSTOMIZE_EXECUTED')\n");
  });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
  function run(code: string, name: string, setup = false, extraArgs: string[] = []) {
    writeFileSync(join(source, "materials", `${name}.py`), code);
    const output = join(root, `output-${name}`); mkdirSync(output);
    const command = isolatedQuestioningCommand({
      snapshot: source, output, dependencies, runtimeRoots: roots, bwrap, setup,
      argv: [python!, `materials/${name}.py`, ...extraArgs],
    });
    // Replit grants its nonroot runner ambient CAP_KILL. Clear that ambient
    // capability so stock bwrap accepts this test environment.
    const result = spawnSync("/usr/bin/setpriv", ["--inh-caps=-all", "--ambient-caps=-all", ...command], {
      encoding: "utf8", timeout: 20000,
      env: { ...process.env, HF_TOKEN: marker, HUGGING_FACE_HUB_TOKEN: marker, API_SECRET: marker, PYTHONPATH: hostilePath, PYTHONSTARTUP: join(hostilePath, "sitecustomize.py") },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(marker);
    expect(result.stdout + result.stderr).not.toContain("HOST_SITECUSTOMIZE_EXECUTED");
    return { data: JSON.parse(result.stdout), output };
  }
  it("removes secrets and parent /proc access in BOTH science and setup subprocesses", () => {
    for (const setup of [false, true]) {
      const { data } = run(`
import os, json, glob, sys, ctypes
paths = ["/proc/1/environ", "/proc/self/environ", "/proc/" + sys.argv[1] + "/environ", "/proc/1/root"]
print(json.dumps({"secret": os.environ.get("HF_TOKEN"), "hub": os.environ.get("HUGGING_FACE_HUB_TOKEN"), "api": os.environ.get("API_SECRET"),
  "startup": os.environ.get("PYTHONSTARTUP"), "proc": [os.path.exists(p) for p in paths],
  "processes": glob.glob("/proc/[0-9]*/environ"), "home": os.environ.get("HOME"), "no_new_privileges": ctypes.CDLL(None).prctl(39, 0, 0, 0, 0)}))
`, `env-${setup}`, setup, [String(process.pid)]);
      expect(data).toMatchObject({ secret: null, hub: null, api: null, startup: null, proc: [false, false, false, false], processes: [], home: "/home/qp", no_new_privileges: 1 });
    }
  });
  it("blocks real socket exfiltration from scientific code", async () => {
    const server = createServer(socket => socket.destroy());
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    try {
      const { data } = run(`
import socket, json, sys
try:
    connection = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=1)
    connection.sendall(b"exfiltration-attempt")
    blocked = False
except OSError:
    blocked = True
print(json.dumps({"network_blocked": blocked}))
`, "network", false, [String(address.port)]);
      expect(data.network_blocked).toBe(true);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("cannot inject sitecustomize or alter dependency contents even when host directories are writable", () => {
    const before = createHash("sha256").update(readFileSync(join(dependencies, "approved.py"))).digest("hex");
    const { data } = run(`
import json, approved
errors = []
for name in ["sitecustomize.py", "approved.py"]:
    try:
        open("/work/python-packages/" + name, "w").write("raise RuntimeError('INJECTED')")
        errors.append(False)
    except OSError:
        errors.append(True)
print(json.dumps({"blocked": errors, "value": approved.VALUE}))
`, "dependency-attack");
    expect(data).toEqual({ blocked: [true, true], value: "approved immutable dependency" });
    expect(existsSync(join(dependencies, "sitecustomize.py"))).toBe(false);
    expect(createHash("sha256").update(readFileSync(join(dependencies, "approved.py"))).digest("hex")).toBe(before);
  });
  it("does not expose prior results, tmp, home/cache helpers or writable source across runs", () => {
    const first = run(`
import os, json
paths = ["/work/results", "/tmp", "/home/qp/.cache"]
for path in paths:
    os.makedirs(path, exist_ok=True)
    open(path + "/unrecorded_helper.py", "w").write("VALUE = 'cross-run injection'\\n")
try:
    open("/work/run/materials/altered.py", "w").write("print('unrecorded')")
    source_blocked = False
except OSError:
    source_blocked = True
print(json.dumps({"source_blocked": source_blocked}))
`, "first");
    expect(first.data.source_blocked).toBe(true);
    expect(existsSync(join(first.output, "unrecorded_helper.py"))).toBe(true);
    const second = run(`
import os, sys, json
sys.path[:0] = ["/work/results", "/tmp", "/home/qp/.cache"]
try:
    import unrecorded_helper
    imported = True
except ImportError:
    imported = False
print(json.dumps({"imported": imported, "host_output_visible": os.path.exists(sys.argv[1]), "old_results": os.listdir("/work/results")}))
`, "second", false, [first.output]);
    expect(second.data).toEqual({ imported: false, host_output_visible: false, old_results: [] });
  });
  it("kills background helper processes when the scientific invocation exits", () => {
    const { output } = run(`
import subprocess, sys, json
subprocess.Popen([sys.executable, "-c", "import time; time.sleep(0.5); open('/work/results/background-helper', 'w').write('persisted')"])
print(json.dumps({"main": "finished"}))
`, "background");
    expect(existsSync(join(output, "background-helper"))).toBe(false);
  });
  it("materializes immutable snapshots as hardlinks rather than repeated source copies", () => {
    const blobs = join(root, "blob-storage"); mkdirSync(blobs);
    const content = "one immutable source body";
    const digest = createHash("sha256").update(content).digest("hex");
    const blob = join(blobs, digest); writeFileSync(blob, content); chmodSync(blob, 0o444);
    const manifest = join(root, "link-manifest.json");
    const script = QUESTIONING_LINK_SNAPSHOT_SCRIPT
      .replace("/work/qp-link-manifest.json", manifest).replace("/work/qp-blobs/", blobs + "/");
    const targets: string[] = [];
    for (const index of [1, 2]) {
      const snapshot = join(root, `linked-snapshot-${index}`);
      const target = join(snapshot, "materials", "code.py"); targets.push(target);
      writeFileSync(manifest, JSON.stringify({ [target]: digest }));
      const result = spawnSync(python!, ["-I", "-c", script, snapshot], { encoding: "utf8", env: {}, timeout: 20000 });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(target, "utf8")).toBe(content);
      expect(statSync(target).ino).toBe(statSync(blob).ino);
    }
    expect(statSync(blob).nlink).toBe(3);
    expect(statSync(targets[0]).size).toBe(Buffer.byteLength(content));
  });
});