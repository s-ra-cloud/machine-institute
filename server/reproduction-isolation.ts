/** qP's filesystem, process, network and environment boundary. No supplied
 * source or dependency path is ever mounted writable into scientific runs. */
export const QP_PATH = "/opt/conda/bin:/usr/local/bin:/usr/bin:/bin";
export const QP_DEPENDENCIES = "/work/python-packages";
export function cleanQuestioningEnvironment(argv: string[]): string[] {
  return ["/usr/bin/env", "-i", `PATH=${QP_PATH}`, "LANG=C.UTF-8", ...argv];
}
export function isolatedQuestioningCommand(input: {
  snapshot: string; output: string; argv: string[]; setup?: boolean;
  /** Dependency injection for real local adversarial tests; production never accepts these from tools. */
  dependencies?: string; runtimeRoots?: string[]; bwrap?: string;
}): string[] {
  const args = [
    input.bwrap ?? "/usr/bin/bwrap", "--unshare-all", "--die-with-parent", "--new-session",
    "--cap-drop", "ALL", "--clearenv",
    "--uid", input.setup ? "0" : "65534", "--gid", input.setup ? "0" : "65534",
  ];
  if (input.setup) args.push("--share-net"); // Only fixed public binary-wheel setup needs networking.
  for (const path of input.runtimeRoots ?? ["/usr", "/bin", "/lib", "/lib64", "/opt/conda"])
    args.push("--ro-bind", path, path);
  for (const path of ["/etc/ssl", "/etc/resolv.conf", "/etc/ld.so.cache"])
    args.push("--ro-bind-try", path, path);
  args.push("--dev", "/dev", "--tmpfs", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/home",
    "--dir", "/home/qp", "--dir", "/work",
    "--ro-bind", input.snapshot, "/work/run",
    input.setup ? "--bind" : "--ro-bind", input.dependencies ?? QP_DEPENDENCIES, QP_DEPENDENCIES,
    "--bind", input.output, "/work/results",
    "--chdir", "/work/run");
  if (!input.setup) {
    for (const device of ["nvidia0", "nvidia1", "nvidiactl", "nvidia-uvm", "nvidia-uvm-tools", "nvidia-modeset", "nvidia-caps"])
      args.push("--dev-bind-try", `/dev/${device}`, `/dev/${device}`);
    // GPU metadata only, never the host proc tree or another process's environ.
    args.push("--ro-bind-try", "/proc/driver/nvidia", "/proc/driver/nvidia");
  }
  for (const [key, value] of Object.entries({
    PATH: QP_PATH, HOME: "/home/qp", TMPDIR: "/tmp", LANG: "C.UTF-8",
    XDG_CACHE_HOME: "/home/qp/.cache", PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1",
    MPLBACKEND: "Agg", TOKENIZERS_PARALLELISM: "false",
    ...(input.setup ? {} : { PYTHONPATH: QP_DEPENDENCIES }),
  })) args.push("--setenv", key, value);
  return cleanQuestioningEnvironment([...args, "--", ...input.argv]);
}

/** Trusted code, run with -I and a clean environment, never with model source.
 * Tree hashes include file contents, paths and symlink targets. Supplemental
 * dependencies additionally retain individual file digests. */
export const QUESTIONING_MANIFEST_SCRIPT = `
import hashlib, json, os, sys
def manifest(root, detailed=False):
    if not os.path.isdir(root): raise RuntimeError("Missing dependency root: " + root)
    tree = hashlib.sha256()
    count = size = 0
    files = {}
    for directory, dirs, names in os.walk(root, followlinks=False):
        dirs.sort()
        for name in sorted(names + [d for d in dirs if os.path.islink(os.path.join(directory, d))]):
            path = os.path.join(directory, name)
            relative = os.path.relpath(path, root)
            if os.path.islink(path):
                if detailed:
                    raise RuntimeError("Supplemental dependency symlinks are not permitted: " + path)
                digest = "symlink:" + os.readlink(path)
            elif os.path.isfile(path):
                h = hashlib.sha256()
                with open(path, "rb") as f:
                    for block in iter(lambda: f.read(1048576), b""): h.update(block)
                digest = h.hexdigest()
                size += os.path.getsize(path)
            else:
                raise RuntimeError("Unsupported dependency object: " + path)
            tree.update((relative + "\\0" + digest + "\\n").encode())
            count += 1
            if detailed: files[relative] = digest
    return dict(root=root, sha256=tree.hexdigest(), files=count, bytes=size, **({"fileHashes": files} if detailed else {}))
result = [manifest("/opt/conda"), manifest("/usr"), manifest("/work/python-packages", True)]
with open("/work/qp-dependencies.json", "w") as f: json.dump(result, f)
print("Immutable dependency manifest saved.")
`;

/** A snapshot is a tree of hardlinks to immutable, content-addressed source,
 * not another physical copy of the entire material corpus per command. */
export const QUESTIONING_LINK_SNAPSHOT_SCRIPT = `
import json, os, re, sys
snapshot = sys.argv[1]
with open("/work/qp-link-manifest.json") as f: files = json.load(f)
os.makedirs(snapshot, exist_ok=True)
for path, digest in files.items():
    if not re.fullmatch("[a-f0-9]{64}", digest) or os.path.commonpath([snapshot, path]) != snapshot:
        raise RuntimeError("Invalid source snapshot reference")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    os.link("/work/qp-blobs/" + digest, path)
`;