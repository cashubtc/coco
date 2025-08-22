import type { Mint } from "../models/Mint";
import type { Keyset } from "../models/Keyset";
import type { Counter } from "../models/Counter";

export interface CoreEvents {
  "mint:added": { mint: Mint; keysets: Keyset[] };
  "mint:updated": { mint: Mint; keysets: Keyset[] };
  "counter:updated": Counter;
}
