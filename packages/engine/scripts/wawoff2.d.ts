declare module 'wawoff2' {
  /** Decodes a WOFF2 file into the TrueType/OpenType font it holds. */
  export function decompress(woff2: Uint8Array): Promise<Uint8Array>;
}
