/**
 * Opt-in local archive of the messages you read.
 *
 * When `HEY_ARCHIVE_DIR` is set, every raw RFC822 message that mcp-hey
 * downloads from `/messages/{id}.text` is also saved as `{id}.eml` in that
 * folder. Only messages you open are saved, and no extra request is made:
 * the file is a copy of a response mcp-hey fetched anyway.
 *
 * Other local tools (for example a search index) can import the folder.
 * Files are written atomically (temporary file, then rename) with mode 600,
 * inside a folder with mode 700. Existing files are never overwritten.
 * Failures are logged to stderr and never break the tool call.
 */

import { existsSync } from "node:fs"
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { heyClient } from "./hey-client"

const MESSAGE_ID = /^\d+$/

/** The archive folder from HEY_ARCHIVE_DIR, or null when archiving is off. */
export function archiveDir(): string | null {
  const raw = process.env.HEY_ARCHIVE_DIR?.trim()
  if (!raw) return null
  const expanded =
    raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw
  return resolve(expanded)
}

/**
 * Save one raw message. Returns the file path when a new file was written,
 * null when archiving is off, the id is not a plain message id, the file
 * already exists, or writing failed.
 */
export async function archiveRawMessage(
  messageId: string,
  raw: string,
): Promise<string | null> {
  const dir = archiveDir()
  if (!dir || !MESSAGE_ID.test(messageId) || !raw) return null
  const target = join(dir, `${messageId}.eml`)
  if (existsSync(target)) return null
  const tmp = join(dir, `.${messageId}.eml.${process.pid}.tmp`)
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
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
 * Use this instead of fetching `/messages/{id}.text` directly.
 */
export async function fetchRawMessage(messageId: string): Promise<string> {
  const raw = await heyClient.fetchHtml(`/messages/${messageId}.text`)
  await archiveRawMessage(messageId, raw)
  return raw
}
