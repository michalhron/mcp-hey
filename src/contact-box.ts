/**
 * Where Hey delivers a sender's mail: Imbox, The Feed or Paper Trail.
 *
 * Every contact has one delivery setting ("Deliver their emails to…" on the
 * contact page). `GET /contacts/{id}/box_settings` renders it as a group of
 * menu buttons, and the chosen one carries `aria-checked="true"`:
 *   action-group__action--imbox | --feedbox | --trailbox | --screened-out
 *
 * Results are kept in the `contact_boxes` cache table for 30 days, so each
 * sender costs at most two requests (search for the contact id, then the
 * settings) per month.
 */

import { parse as parseHtml } from "node-html-parser"
import { execute, queryOne, unixNow } from "./cache/db"
import { heyClient } from "./hey-client"
import { findContactIdByEmail } from "./tools/organise"

export type ContactBox = "imbox" | "feed" | "paper_trail" | "screened_out"

const CLASS_TO_BOX: Record<string, ContactBox> = {
  "action-group__action--imbox": "imbox",
  "action-group__action--feedbox": "feed",
  "action-group__action--trailbox": "paper_trail",
  "action-group__action--screened-out": "screened_out",
}
const TTL_SECONDS = 30 * 86400

/** The selected delivery box in a contact's box settings HTML, or null when none is marked. */
export function parseDeliveryBox(html: string): ContactBox | null {
  const root = parseHtml(html)
  const buttons = root.querySelectorAll(
    '[data-bridge-group="deliver"][role="menuitemradio"]',
  )
  for (const button of buttons) {
    const selected =
      button.getAttribute("aria-checked") === "true" ||
      button.getAttribute("data-bridge-selected") === "true"
    if (!selected) continue
    for (const cls of (button.getAttribute("class") ?? "").split(/\s+/)) {
      if (CLASS_TO_BOX[cls]) return CLASS_TO_BOX[cls]
    }
  }
  return null
}

function cached(sender: string): ContactBox | null {
  const row = queryOne<{ box: ContactBox; checked_at: number }>(
    "SELECT box, checked_at FROM contact_boxes WHERE sender_email = ?",
    [sender],
  )
  return row && unixNow() - row.checked_at < TTL_SECONDS ? row.box : null
}

/**
 * Delivery box of a sender, from the cache or from Hey (two requests).
 * Returns null when the sender is not a contact or the page cannot be read.
 */
export async function contactBox(
  senderEmail: string,
): Promise<ContactBox | null> {
  const sender = senderEmail.trim().toLowerCase()
  if (!sender.includes("@")) return null
  const hit = cached(sender)
  if (hit) return hit
  const contactId = await findContactIdByEmail(sender)
  if (!contactId) return null
  const box = parseDeliveryBox(
    await heyClient.fetchHtml(`/contacts/${contactId}/box_settings`),
  )
  if (box) {
    execute(
      "INSERT OR REPLACE INTO contact_boxes (sender_email, box, checked_at) VALUES (?, ?, ?)",
      [sender, box, unixNow()],
    )
  }
  return box
}

export const __testing = { CLASS_TO_BOX }
