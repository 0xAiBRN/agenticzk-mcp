// circomlibjs ships no .d.ts; we use only buildBabyjub() and a handful of
// methods on the returned object. Keep the surface tight.
declare module "circomlibjs" {
  type Point = [Uint8Array, Uint8Array];

  export interface BabyJubField {
    e(x: bigint | string | number): Uint8Array;
    toString(x: Uint8Array): string;
    neg(x: Uint8Array): Uint8Array;
  }

  export interface BabyJub {
    F: BabyJubField;
    Base8: Point;
    subOrder: bigint;
    mulPointEscalar(p: Point, k: bigint): Point;
    addPoint(a: Point, b: Point): Point;
  }

  export function buildBabyjub(): Promise<BabyJub>;

  // Poseidon hash — buildPoseidon() returns a callable that hashes an input
  // array (matching circomlib's `Poseidon(n)` / `PoseidonEx(n,1)` with
  // initialState 0). `.F.toString` renders the field element as a decimal
  // string. Used by deck-commit.ts to mirror the `DeckCommit` circuit.
  export interface PoseidonField {
    toString(x: unknown): string;
  }
  export interface Poseidon {
    (inputs: (bigint | number | string)[]): unknown;
    F: PoseidonField;
  }
  export function buildPoseidon(): Promise<Poseidon>;
}
