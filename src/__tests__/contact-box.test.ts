import { describe, expect, test } from "bun:test"
import { parseDeliveryBox } from "../contact-box"

/** Synthetic markup in the shape of /contacts/{id}/box_settings. */
function settings(selected: string): string {
  const item = (cls: string, title: string) => {
    const on = cls === selected
    return `<div class="action-group__item${on ? " action-group__item--selected" : ""}">
      <button name="button" type="submit" class="action-group__action--${cls} action-group__action"
        role="menuitemradio" aria-checked="${on}" data-bridge-group="deliver"
        data-bridge-selected="${on}"><span>${title}</span></button></div>`
  }
  return `<turbo-frame id="contact_box_settings">
    <div class="action-group" role="group">
      <h3 class="action-group__title">Deliver their emails to…</h3>
      ${item("imbox", "Imbox")}${item("feedbox", "The Feed")}${item("trailbox", "Paper Trail")}
      ${item("screened-out", "Screened Out")}
    </div>
    <div class="action-group" role="group">
      <button class="action-group__action--unbundled action-group__action" role="menuitemradio"
        aria-checked="true" data-bridge-group="display">Separately</button>
    </div>
  </turbo-frame>`
}

describe("parseDeliveryBox", () => {
  test("reads the selected delivery destination", () => {
    expect(parseDeliveryBox(settings("imbox"))).toBe("imbox")
    expect(parseDeliveryBox(settings("feedbox"))).toBe("feed")
    expect(parseDeliveryBox(settings("trailbox"))).toBe("paper_trail")
    expect(parseDeliveryBox(settings("screened-out"))).toBe("screened_out")
  })

  test("ignores other groups and pages without a selection", () => {
    expect(parseDeliveryBox(settings("none"))).toBeNull()
    expect(parseDeliveryBox("<html><body>Sign in</body></html>")).toBeNull()
  })
})
