/**
 * Opt-in local archive of the messages you read.
 *
 * When `HEY_ARCHIVE_DIR` is set, every raw RFC822 message that mcp-hey
 * downloads from `/messages/{id}.text` is also saved as `{box}/{id}.eml` in
 * that folder. Only messages you open are saved, and no extra request is
 * made: the file is a copy of a response mcp-hey fetched anyway.
 *
 * `{box}` is where Hey files the message: `imbox`, `feed`, `paper_trail`,
 * `set_aside` or `reply_later`, else `unknown`. It is found in this order:
 *   1. the box this message was listed in (mcp-hey's cache, no request),
 *   2. the sender's delivery setting on their Hey contact page ("Deliver
 *      their emails to…"), cached for 30 days. This costs two requests the
 *      first time a sender is seen. `HEY_ARCHIVE_SENDER_LOOKUP=off` skips it,
 *   3. the box other mail from the same sender was listed in (no request),
 *   4. `unknown`.
 * `HEY_ARCHIVE_BOXES` (comma-separated, e.g. `imbox,set_aside,reply_later`)
 * limits which boxes are saved. Include `unknown` to keep messages whose box
 * could not be determined. Unset means every box.
 *
 * Files are written atomically (temporary file, then rename) with mode 600,
 * inside folders with mode 700. Existing files are never overwritten.
 * Failures are logged to stderr and never break the tool call.
 */

import { existsSync } from "node:fs"
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { queryOne } from "./cache/db"
import { contactBox } from "./contact-box"
import { heyClient } from "./hey-client"

const MESSAGE_ID = /^\d+$/
export const BOXES = [
  "imbox",
  "feed",
  "paper_trail",
  "set_aside",
  "reply_later",
  "unknown",
] as const
export type Box = (typeof BOXES)[number]
/** Listings that say where a sender's mail is delivered. Set Aside and Reply Later hold mail from any destination. */
const DESTINATIONS = ["imbox", "feed", "paper_trail"]

/** The archive folder from HEY_ARCHIVE_DIR, or null when archiving is off. */
export function archiveDir(): string | null {
  const raw = process.env.HEY_ARCHIVE_DIR?.trim()
  if (!raw) return null
  const expanded =
    raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw
  return resolve(expanded)
}

/** Boxes to save, from HEY_ARCHIVE_BOXES. Unset or empty means all. Unknown names are ignored. */
export function archiveBoxes(): Set<Box> {
  const raw = process.env.HEY_ARCHIVE_BOXES?.trim()
  if (!raw) return new Set(BOXES)
  const wanted = raw.split(",").map((b) => b.trim().toLowerCase())
  return new Set(BOXES.filter((b) => wanted.includes(b)))
}

/** Lowercased address from the From header of a raw message, if any. */
export function senderOf(raw: string): string | null {
  const end = raw.search(/\r?\n\r?\n/)
  const head = end >= 0 ? raw.slice(0, end) : raw
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ")
  const from = unfolded.match(/^from:(.*)$/im)
  if (!from) return null
  const angle = from[1].match(/<([^<>\s]+@[^<>\s]+)>/)
  const bare = from[1].match(/([^\s<>"',;]+@[^\s<>"',;]+)/)
  const addr = angle?.[1] ?? bare?.[1]
  return addr ? addr.toLowerCase() : null
}

export interface BoxLookup {
  /** Box a listing id was cached under, or null. */
  listed(listingId: string): string | null
  /** The sender's delivery setting in Hey, or null when unknown. May make requests. */
  contactBox(sender: string): Promise<string | null>
  /** Destination box most of a sender's listed mail was in, or null. */
  senderBox(sender: string): string | null
}

function senderLookupEnabled(): boolean {
  const v = process.env.HEY_ARCHIVE_SENDER_LOOKUP?.trim().toLowerCase()
  return !(v === "off" || v === "false" || v === "0" || v === "no")
}

const cacheLookup: BoxLookup = {
  contactBox: (sender) =>
    senderLookupEnabled() ? contactBox(sender) : Promise.resolve(null),
  listed(listingId) {
    const row = queryOne<{ folder: string }>(
      "SELECT folder FROM messages WHERE id = ?",
      [listingId],
    )
    return row?.folder ?? null
  },
  senderBox(sender) {
    const marks = DESTINATIONS.map(() => "?").join(",")
    const row = queryOne<{ folder: string }>(
      `SELECT folder, COUNT(*) AS n FROM messages
       WHERE lower(sender_email) = ? AND folder IN (${marks})
       GROUP BY folder ORDER BY n DESC LIMIT 1`,
      [sender, ...DESTINATIONS],
    )
    return row?.folder ?? null
  },
}

/** Where Hey files a message. See the module comment for the order. */
export async function resolveBox(
  ids: string[],
  sender: string | null,
  lookup: BoxLookup = cacheLookup,
): Promise<Box> {
  try {
    for (const id of ids) {
      const box = lookup.listed(id)
      if (
        box &&
        (BOXES as readonly string[]).includes(box) &&
        box !== "unknown"
      )
        return box as Box
    }
  } catch (err) {
    console.error("[mcp-hey] Could not look up the listing of a message", err)
  }
  if (!sender) return "unknown"
  try {
    const box = await lookup.contactBox(sender)
    if (box && DESTINATIONS.includes(box)) return box as Box
  } catch (err) {
    console.error("[mcp-hey] Could not read the sender's delivery setting", err)
  }
  try {
    const box = lookup.senderBox(sender)
    if (box && DESTINATIONS.includes(box)) return box as Box
  } catch (err) {
    console.error("[mcp-hey] Could not look up the sender's listed mail", err)
  }
  return "unknown"
}

/**
 * Save one raw message under its box. Returns the file path when a new file
 * was written, null when archiving is off, the box is not wanted, the id is
 * not a plain message id, the message is already saved, or writing failed.
 */
export async function archiveRawMessage(
  messageId: string,
  raw: string,
  context: { listingIds?: string[]; lookup?: BoxLookup } = {},
): Promise<string | null> {
  const dir = archiveDir()
  if (!dir || !MESSAGE_ID.test(messageId) || !raw) return null
  if (BOXES.some((b) => existsSync(join(dir, b, `${messageId}.eml`))))
    return null
  const ids = [...(context.listingIds ?? []), messageId]
  const box = await resolveBox(ids, senderOf(raw), context.lookup)
  if (!archiveBoxes().has(box)) return null
  const folder = join(dir, box)
  const target = join(folder, `${messageId}.eml`)
  const tmp = join(folder, `.${messageId}.eml.${process.pid}.tmp`)
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await writeFile(tmp, raw, { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, target)
    return target
  } catch (err) {
    console.error("[mcp-hey] Could not archive message", messageId, err)
    await unlink(tmp).catch(() => {})
    return null
  }
}

/**
 * Fetch the raw RFC822 source of a message and archive it when enabled.
 * `listingIds` are the ids the message was reached by (topic or posting ids
 * from a listing), used to find its box. Use this instead of fetching
 * `/messages/{id}.text` directly.
 */
export async function fetchRawMessage(
  messageId: string,
  listingIds: string[] = [],
  lookup?: BoxLookup,
): Promise<string> {
  const raw = await heyClient.fetchHtml(`/messages/${messageId}.text`)
  await archiveRawMessage(messageId, raw, { listingIds, lookup })
  return raw
}
