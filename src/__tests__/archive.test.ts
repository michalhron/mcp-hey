import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type BoxLookup,
  archiveBoxes,
  archiveDir,
  archiveRawMessage,
  fetchRawMessage,
  resolveBox,
  senderOf,
} from "../archive"
import { heyClient } from "../hey-client"

const RAW = [
  'From: "Pat Example" <Pat@Example.org>',
  "Message-ID: <abc@example.com>",
  "Subject: Test",
  "",
  "Hello. From: not@a-header.example",
].join("\r\n")

/** A cache where listing 900 was in the imbox and news@example.net's mail was in the feed. */
const lookup: BoxLookup = {
  listed: (id) =>
    ({ "900": "imbox", "901": "set_aside", "902": "unknown" })[id] ?? null,
  senderBox: (s) =>
    ({ "news@example.net": "feed", "pat@example.org": "paper_trail" })[s] ??
    null,
}
const none: BoxLookup = { listed: () => null, senderBox: () => null }

let dir: string
const saved = {
  dir: process.env.HEY_ARCHIVE_DIR,
  boxes: process.env.HEY_ARCHIVE_BOXES,
}

function unset(name: string) {
  Reflect.deleteProperty(process.env, name)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hey-archive-"))
  unset("HEY_ARCHIVE_BOXES")
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (saved.dir === undefined) unset("HEY_ARCHIVE_DIR")
  else process.env.HEY_ARCHIVE_DIR = saved.dir
  if (saved.boxes === undefined) unset("HEY_ARCHIVE_BOXES")
  else process.env.HEY_ARCHIVE_BOXES = saved.boxes
})

describe("senderOf", () => {
  test("reads the From header only", () => {
    expect(senderOf(RAW)).toBe("pat@example.org")
    expect(senderOf("From: bare@example.org\n\nbody")).toBe("bare@example.org")
    expect(senderOf("From: Folded\r\n <folded@example.org>\r\n\r\nbody")).toBe(
      "folded@example.org",
    )
    expect(senderOf("Subject: x\n\nFrom: body@example.org")).toBeNull()
  })
})

describe("resolveBox", () => {
  test("the message's own listing wins", () => {
    expect(resolveBox(["900"], "news@example.net", lookup)).toBe("imbox")
    expect(resolveBox(["901"], "news@example.net", lookup)).toBe("set_aside")
  })

  test("falls back to the sender's destination, then unknown", () => {
    expect(resolveBox(["999"], "news@example.net", lookup)).toBe("feed")
    expect(resolveBox(["902"], "pat@example.org", lookup)).toBe("paper_trail")
    expect(resolveBox(["999"], "new@example.org", lookup)).toBe("unknown")
    expect(resolveBox([], null, lookup)).toBe("unknown")
  })

  test("a failing lookup gives unknown", () => {
    const err = spyOn(console, "error").mockImplementation(() => {})
    const broken: BoxLookup = {
      listed: () => {
        throw new Error("db gone")
      },
      senderBox: () => null,
    }
    expect(resolveBox(["900"], "x@example.org", broken)).toBe("unknown")
    err.mockRestore()
  })
})

describe("archive", () => {
  test("off when HEY_ARCHIVE_DIR is unset or empty", async () => {
    unset("HEY_ARCHIVE_DIR")
    expect(archiveDir()).toBeNull()
    process.env.HEY_ARCHIVE_DIR = "  "
    expect(archiveDir()).toBeNull()
    expect(await archiveRawMessage("123", RAW, { lookup })).toBeNull()
  })

  test("HEY_ARCHIVE_BOXES", () => {
    expect(archiveBoxes().size).toBe(6)
    process.env.HEY_ARCHIVE_BOXES = "Imbox, set_aside,bogus"
    expect([...archiveBoxes()].sort()).toEqual(["imbox", "set_aside"])
  })

  test("writes {box}/{id}.eml with mode 600 in folders with mode 700", async () => {
    const target = join(dir, "sub")
    process.env.HEY_ARCHIVE_DIR = target
    const path = await archiveRawMessage("123", RAW, {
      listingIds: ["900"],
      lookup,
    })
    expect(path).toBe(join(target, "imbox", "123.eml"))
    expect(readFileSync(join(target, "imbox", "123.eml"), "utf8")).toBe(RAW)
    expect(statSync(join(target, "imbox", "123.eml")).mode & 0o777).toBe(0o600)
    expect(statSync(target).mode & 0o777).toBe(0o700)
    expect(statSync(join(target, "imbox")).mode & 0o777).toBe(0o700)
    expect(readdirSync(join(target, "imbox"))).toEqual(["123.eml"])
  })

  test("skips boxes that are not wanted", async () => {
    process.env.HEY_ARCHIVE_DIR = dir
    process.env.HEY_ARCHIVE_BOXES = "imbox"
    const feedRaw = RAW.replace("Pat@Example.org", "news@example.net")
    expect(await archiveRawMessage("124", feedRaw, { lookup })).toBeNull()
    expect(await archiveRawMessage("125", RAW, { lookup: none })).toBeNull() // unknown not listed
    expect(
      await archiveRawMessage("126", RAW, { listingIds: ["900"], lookup }),
    ).toBe(join(dir, "imbox", "126.eml"))
    process.env.HEY_ARCHIVE_BOXES = "imbox,unknown"
    expect(await archiveRawMessage("125", RAW, { lookup: none })).toBe(
      join(dir, "unknown", "125.eml"),
    )
  })

  test("never overwrites, also across boxes", async () => {
    process.env.HEY_ARCHIVE_DIR = dir
    mkdirSync(join(dir, "feed"), { recursive: true })
    writeFileSync(join(dir, "feed", "123.eml"), "original")
    expect(
      await archiveRawMessage("123", RAW, { listingIds: ["900"], lookup }),
    ).toBeNull()
    expect(existsSync(join(dir, "imbox", "123.eml"))).toBe(false)
    expect(readFileSync(join(dir, "feed", "123.eml"), "utf8")).toBe("original")
  })

  test("rejects ids that are not plain message ids", async () => {
    process.env.HEY_ARCHIVE_DIR = dir
    for (const id of ["../123", "12/3", "abc", ""]) {
      expect(await archiveRawMessage(id, RAW, { lookup })).toBeNull()
    }
    expect(readdirSync(dir)).toEqual([])
  })

  test("fetchRawMessage archives what it fetched, without a second request", async () => {
    process.env.HEY_ARCHIVE_DIR = dir
    const spy = spyOn(heyClient, "fetchHtml").mockResolvedValue(RAW)
    const err = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(await fetchRawMessage("456", ["topic-1"], none)).toBe(RAW)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith("/messages/456.text")
      expect(BOXES_ON_DISK(dir)).toEqual([join("unknown", "456.eml")])
    } finally {
      spy.mockRestore()
      err.mockRestore()
    }
  })

  test("a failed write does not break the fetch", async () => {
    const blocker = join(dir, "file")
    writeFileSync(blocker, "")
    process.env.HEY_ARCHIVE_DIR = join(blocker, "inside")
    const spy = spyOn(heyClient, "fetchHtml").mockResolvedValue(RAW)
    const err = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(await fetchRawMessage("789", [], none)).toBe(RAW)
    } finally {
      spy.mockRestore()
      err.mockRestore()
    }
  })
})

function BOXES_ON_DISK(root: string): string[] {
  return readdirSync(root).flatMap((box) =>
    readdirSync(join(root, box)).map((f) => join(box, f)),
  )
}
