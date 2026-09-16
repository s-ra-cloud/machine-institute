// Fetches a Future Science contribution's supplementary materials (README,
// analysis scripts, raw result files, notebooks, figures) so the reproduction
// agent can work from exactly what the authors shipped alongside the paper.

const FS_API_BASE = "https://future-science.org/api/v1";
const FS_ORIGIN = "https://future-science.org";

const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "txt", "rst", "py", "json", "ipynb", "csv", "tsv", "yaml", "yml",
  "toml", "cfg", "ini", "sh", "bash", "r", "jl", "tex", "html", "htm", "js", "ts",
  "sql", "xml", "env", "lock", "in", "cff", "bib",
]);

const MAX_TEXT_FILE_BYTES = 1_500_000;
const MAX_TOTAL_TEXT_BYTES = 25_000_000;
const FETCH_TIMEOUT_MS = 20_000;

export interface MaterialFile {
  name: string;
  url: string;
  ext: string;
  mime: string | null;
  kind: "text" | "binary";
  source: "additional" | "paper" | "cover";
  text?: string;
  bytes?: number;
  truncated?: boolean;
  fetchError?: string;
}

export interface ContributionMaterials {
  documentId: string;
  files: MaterialFile[];
  readme: string | null;
  paperMarkdown: string | null;
  textFileCount: number;
  binaryFileCount: number;
  totalTextBytes: number;
}

interface FsFileEntry {
  name?: string;
  ext?: string;
  mime?: string | null;
  url?: string;
}

function resolveUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${FS_ORIGIN}${url.startsWith("/") ? "" : "/"}${url}`;
}

function extOf(entry: FsFileEntry): string {
  const fromExt = (entry.ext || "").replace(/^\./, "").toLowerCase();
  if (fromExt) return fromExt;
  const m = (entry.name || "").match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "";
}

// Common no-extension text files shipped with code (Makefile, LICENSE, ...).
function isTextByName(name: string): boolean {
  return /^(readme|license|licence|makefile|dockerfile|requirements|environment|notice|changelog)/i.test(name);
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { "User-Agent": "MachineInstitute-ReproductionAgent", Accept: "*/*" },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchContributionJson(documentId: string): Promise<Record<string, unknown> | null> {
  const candidates = [
    `${FS_API_BASE}/public/contributions/${encodeURIComponent(documentId)}`,
    `${FS_API_BASE}/contributions/${encodeURIComponent(documentId)}`,
  ];
  for (const url of candidates) {
    try {
      const resp = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (!resp.ok) continue;
      const json = (await resp.json()) as { data?: Record<string, unknown> } | Record<string, unknown>;
      const data = (json as { data?: Record<string, unknown> }).data ?? json;
      if (data && typeof data === "object") return data as Record<string, unknown>;
    } catch {
      // try next
    }
  }
  return null;
}

function collectEntries(data: Record<string, unknown>): Array<{ entry: FsFileEntry; source: MaterialFile["source"] }> {
  const out: Array<{ entry: FsFileEntry; source: MaterialFile["source"] }> = [];
  const submitted = data.submittedFiles as { file?: FsFileEntry; cover?: FsFileEntry } | undefined;
  if (submitted?.file?.url) out.push({ entry: submitted.file, source: "paper" });
  if (submitted?.cover?.url) out.push({ entry: submitted.cover, source: "cover" });
  const additional = data.additionalMaterialsFiles;
  if (Array.isArray(additional)) {
    for (const e of additional) {
      if (e && typeof e === "object" && typeof (e as FsFileEntry).url === "string") {
        out.push({ entry: e as FsFileEntry, source: "additional" });
      }
    }
  }
  return out;
}

export async function fetchContributionMaterials(documentId: string): Promise<ContributionMaterials> {
  const empty: ContributionMaterials = {
    documentId, files: [], readme: null, paperMarkdown: null,
    textFileCount: 0, binaryFileCount: 0, totalTextBytes: 0,
  };
  const data = await fetchContributionJson(documentId);
  if (!data) return empty;

  const entries = collectEntries(data);
  const files: MaterialFile[] = [];
  let totalTextBytes = 0;
  // Dedupe by resolved URL: the cover image is often duplicated in additionalMaterialsFiles.
  const seenUrls = new Set<string>();

  for (const { entry, source } of entries) {
    const url = resolveUrl(entry.url || "");
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    const name = entry.name || url.split("/").pop() || "file";
    const ext = extOf(entry);
    const isText = TEXT_EXTENSIONS.has(ext) || (!ext && isTextByName(name));
    const file: MaterialFile = {
      name, url, ext, mime: entry.mime ?? null,
      kind: isText ? "text" : "binary",
      source,
    };
    if (isText && totalTextBytes < MAX_TOTAL_TEXT_BYTES) {
      try {
        const resp = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
        if (!resp.ok) {
          file.fetchError = `HTTP ${resp.status}`;
        } else {
          let text = await resp.text();
          file.bytes = Buffer.byteLength(text, "utf8");
          if (file.bytes > MAX_TEXT_FILE_BYTES) {
            text = text.slice(0, MAX_TEXT_FILE_BYTES);
            file.truncated = true;
          }
          file.text = text;
          totalTextBytes += Math.min(file.bytes, MAX_TEXT_FILE_BYTES);
        }
      } catch (err) {
        file.fetchError = err instanceof Error ? err.message : String(err);
      }
    }
    files.push(file);
  }

  const readmeFile = files.find(f => f.kind === "text" && /^readme(\.|$)/i.test(f.name) && f.text);
  const paperFile = files.find(f => f.source === "paper" && f.text);

  return {
    documentId,
    files,
    readme: readmeFile?.text ?? null,
    paperMarkdown: paperFile?.text ?? null,
    textFileCount: files.filter(f => f.kind === "text").length,
    binaryFileCount: files.filter(f => f.kind === "binary").length,
    totalTextBytes,
  };
}

// Build a sandbox-relative path for a material file. Files keep their original
// names inside /work/materials; the paper itself goes to /work/paper.md.
export function materialSandboxPath(file: MaterialFile): string {
  if (file.source === "paper") return "/work/paper.md";
  const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_");
  return `/work/materials/${safe}`;
}

// Compact inventory of the shipped materials for the reproducer's first prompt.
export function formatMaterialsInventory(m: ContributionMaterials): string {
  if (m.files.length === 0) return "(No supplementary materials are attached to this contribution on Future Science.)";
  const lines = m.files.map(f => {
    const where = materialSandboxPath(f);
    const size = f.bytes !== undefined ? `${(f.bytes / 1024).toFixed(1)} KB` : f.kind === "binary" ? "binary" : "n/a";
    const flags = [f.truncated ? "truncated" : "", f.fetchError ? `fetch failed: ${f.fetchError}` : ""].filter(Boolean).join(", ");
    return `- ${where} (${f.ext || "no ext"}, ${size}${flags ? `, ${flags}` : ""})${f.kind === "binary" ? ` — binary, not uploaded; original at ${f.url}` : ""}`;
  });
  return lines.join("\n");
}
