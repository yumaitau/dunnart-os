/** Stable embedding model: changing it requires rebuilding persisted vectors. */
export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

/** Bounded Workers AI embedding call. Invalid responses never enter an index. */
export async function embedTexts(ai: Ai, texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  if (texts.length > 32) throw new RangeError("Embedding batch exceeds 32 texts.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      ai.run(EMBEDDING_MODEL, { text: texts.map(text => text.slice(0, 1200)) }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Embedding timed out.")), 10_000); }),
    ]);
    if (!("data" in result) || !Array.isArray(result.data) || result.data.length !== texts.length
        || result.data.some(vector => !Array.isArray(vector) || vector.length !== 768
          || vector.some(value => !Number.isFinite(value)) || !vector.some(value => value !== 0))) {
      throw new Error("Invalid embedding response.");
    }
    return result.data;
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Cosine similarity, with malformed or incompatible vectors treated as unrelated. */
export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, left = 0, right = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; left += a[i] ** 2; right += b[i] ** 2;
  }
  const score = dot / Math.sqrt(left * right);
  return Number.isFinite(score) ? score : 0;
}

/** Content fingerprints detect replacements while an embedding request is in flight. */
export async function textDigest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
