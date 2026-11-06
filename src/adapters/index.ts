/** Registry of every agent adapter. Adding an agent means adding it here. */
import type { Adapter } from "../types";
import { claudeCode } from "./claudeCode";
import { codex } from "./codex";
import { cursor } from "./cursor";
import { geminiCli } from "./geminiCli";
import { opencode } from "./opencode";
import { rawAdapters } from "./rawFiles";

export const ADAPTERS: Adapter[] = [claudeCode, codex, geminiCli, opencode, cursor, ...rawAdapters];

/** Returns the adapters to run, optionally limited to the given ids. */
export function selectAdapters(only?: string[]): Adapter[] {
  if (!only?.length) return ADAPTERS;
  const unknown = only.filter((id) => !ADAPTERS.some((a) => a.id === id));
  if (unknown.length) throw new Error(`Unknown agent(s): ${unknown.join(", ")}. Known: ${ADAPTERS.map((a) => a.id).join(", ")}`);
  return ADAPTERS.filter((a) => only.includes(a.id));
}
