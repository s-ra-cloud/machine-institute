/** Evidence accepts only a single planned script; shell status must be its status. */
export function isPlannedEntrypoint(command: string, paths: string[]): boolean {
  if (/[;&|<>`$\r\n]/.test(command)) return false;
  const match = /^(?:python3?|bash|sh|node|Rscript|julia)\s+((?:\/work\/)?materials\/[^\s"';&|<>`$]+)(?:\s|$)/.exec(command);
  const path = match?.[1].startsWith("/work/") ? match[1] : match ? `/work/${match[1]}` : "";
  return /\.(?:py|sh|js|mjs|r|jl)$/i.test(path) && paths.includes(path);
}

export function rerunLaunchRefusal(command: string, paths: string[], questioning = false): string | undefined {
  if (isPlannedEntrypoint(command, paths)) return;
  const launches = command.matchAll(/(?:^|[\s;&|])(?:python3?|bash|sh|node|Rscript|julia)\s+["']?([^\s"';&|<>`$]+)/g);
  for (const launch of Array.from(launches)) {
    const filename = launch[1].split("/").pop();
    const planned = paths.find(path => path.split("/").pop() === filename);
    if (planned) return `Refused before execution: a planned rerun must be a standalone source entrypoint, e.g. python ${questioning ? planned.replace(/^\/work\//, "") : planned}. ${questioning ? "Omit working_directory: qP uses its sealed snapshot." : "Set working_directory to /work/materials if needed."} Do not use cd, shell chaining, pipes, tee or redirection; stdout and stderr are already retained. The script's own exit status is required for evidence.`;
  }
}
