/**
 * Type declaration for @img/sharp-wasm32.
 *
 * The WASM build of sharp has the same API as native sharp but doesn't
 * ship its own type declarations.
 */
declare module '@img/sharp-wasm32' {
  // biome-ignore lint/suspicious/noExplicitAny: WASM module export shape varies
  const sharp: any;
  export default sharp;
  export = sharp;
}
