/**
 * Parse JSON from a fetch Response. Empty bodies (e.g. some 502/proxy errors) return `{}` instead of throwing.
 */
export async function readResponseJson<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Server returned non-JSON (${res.status})`);
  }
}
