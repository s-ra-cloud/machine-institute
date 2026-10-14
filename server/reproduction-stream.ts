/** Retain partial output if Modal closes a stream on process termination. */
export async function captureProcessStream(stream: {
  readText(): Promise<string>;
  getReader?: () => ReadableStreamDefaultReader<string | Uint8Array>;
}): Promise<string> {
  if (!stream.getReader) {
    return stream.readText().catch(() => "[capture error: process output unavailable]");
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const limit = 200_000;
  let omitted = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = typeof value === "string" ? value : decoder.decode(value, { stream: true });
      output += text;
      if (output.length > limit) {
        const excess = output.length - limit;
        omitted += excess;
        output = output.slice(0, limit / 2) + output.slice(limit / 2 + excess);
      }
    }
    output += decoder.decode();
  } catch {
    output += "\n[capture error: stream interrupted; preceding output retained]";
  } finally {
    reader.releaseLock();
  }
  if (omitted) output = output.slice(0, limit / 2) + `\n[... ${omitted} characters omitted from capture ...]\n` + output.slice(limit / 2);
  return output;
}
