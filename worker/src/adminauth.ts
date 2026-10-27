/** Admin authentication helpers. */
export function verifyAdminToken(supplied: string, expected: string | undefined): boolean {
  if (!expected || !supplied || supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  return diff === 0;
}
