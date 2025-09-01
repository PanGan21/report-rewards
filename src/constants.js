import dotenv from "dotenv";
dotenv.config({ path: ".env", quiet: true });

export const NODE_URL =
  process.env.NODE_URL || "wss://public-rpc.mainnet.energywebx.com";
export const INDEXER_URL = process.env.INDEXER_URL;
export const REWARD_PERIOD_INDEX = Number(process.env.REWARD_PERIOD_INDEX);
export const GROUP_NAMESPACE = process.env.GROUP_NAMESPACE;
export const ADDRESS = process.env.ADDRESS;
export const SPECIFIC_BLOCK_HASH = process.env.SPECIFIC_BLOCK_HASH;
