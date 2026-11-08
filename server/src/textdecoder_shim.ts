// The SpacetimeDB JS runtime's TextDecoder only accepts canonical labels ("utf-8").
// h3-js (Emscripten output) asks for "utf8" and "utf-16le" at import time, so map the
// alias and supply a small UTF-16LE decoder. Must be imported before h3-js.
const Native = (globalThis as any).TextDecoder;

class Utf16LeDecoder {
  readonly encoding = 'utf-16le';
  decode(input?: ArrayBufferView | ArrayBuffer): string {
    if (!input) return '';
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    }
    return out;
  }
}

if (Native) {
  const Shim = function (this: unknown, label = 'utf-8', options?: unknown) {
    const l = String(label).trim().toLowerCase();
    if (l === 'utf8' || l === 'unicode-1-1-utf-8') return new Native('utf-8', options);
    try {
      return new Native(label, options);
    } catch (e) {
      if (l === 'utf-16le' || l === 'utf-16') return new Utf16LeDecoder();
      throw e;
    }
  } as unknown as typeof TextDecoder;
  (Shim as any).prototype = Native.prototype;
  (globalThis as any).TextDecoder = Shim;
}

export {};
