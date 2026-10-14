// Full-token activation caches across hundreds of prompts can exceed 20 GiB.
// Preserve the scientific task set and code, rather than silently shrinking them.
export const REPRODUCTION_RESOURCES = { cpu: 2, memoryMiB: 32768 } as const;
