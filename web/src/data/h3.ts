// H3 parent cell without pulling h3-js into the web bundle. An H3 index stores its resolution in
// bits 52-55 and one 3-bit digit per resolution (res r at bits 45-3r .. 47-3r); unused digits are 7.
// The parent at resolution p is the same index with resolution p and digits p+1..15 set to 7.
export function cellToParent(cell: string, parentRes: number): string {
  if (!/^[0-9a-f]{15,16}$/i.test(cell)) return '';
  let h = BigInt('0x' + cell);
  const res = Number((h >> 52n) & 0xfn);
  if (parentRes > res) return '';
  if (parentRes === res) return cell.toLowerCase();
  h = (h & ~(0xfn << 52n)) | (BigInt(parentRes) << 52n);
  for (let r = parentRes + 1; r <= res; r++) h |= 7n << BigInt(45 - 3 * r);
  return h.toString(16);
}

/** Incident reports are written per res-8 cell. */
export const REPORT_RES = 8;
