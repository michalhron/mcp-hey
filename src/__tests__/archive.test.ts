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

/** Listing 900 was in the imbox. boss@ is delivered to the Imbox. news@'s mail was listed in the Feed. */
const lookup: BoxLookup = {
  listed: (id) =>
    ({ "900": "imbox", "901": "set_aside", "902": "unknown" })[id] ?? null,
  contactBox: async (s) =>
    ({ "boss@example.org": "imbox", "shop@example.com": "screened_out" })[s] ??
    null,
  senderBox: (s) =>
    ({ "news@example.net": "feed", "pat@example.org": "paper_trail" })[s] ??
    null,
}
const none: BoxLookup = {
  listed: () => null,
  contactBox: async () => null,
  senderBox: () => null,
}

let dir: string
const saved = {
  dir: process.env.HEY_ARCHIVE_DIR,
  boxes: process.env.HEY_ARCHIVE_BOXES,
}

function unset(name: string) {
  Reflect.deleteProperty(process.env, name)
}

function filesOnDisk(root: string): string[] {
  return readdirSync(root).flatMap((box) =>
    readdirSync(join(root, box)).map((f) => join(box, f)),
  )
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
  test("the message's own listing wins", async () => {
    expect(await resolveBox(["900"], "news@example.net", lookup)).toBe("imbox")
    expect(await resolveBox(["901"], "boss@example.org", lookup)).toBe(
      "set_aside",
    )
  })

  test("then the delivery setting, then the sender's listed mail, then unknown", async () => {
    expect(await resolveBox(["999"], "boss@example.org", lookup)).toBe("imbox")
    expect(await resolveBox(["999"], "news@example.net", lookup)).toBe("feed")
    expect(await resolveBox(["902"], "pat@example.org", lookup)).toBe(
      "paper_trail",
    )
    expect(await resolveBox(["999"], "shop@example.com", lookup)).toBe(
      "unknown",
    ) // screened out
    expect(await resolveBox(["999"], "new@example.org", lookup)).toBe("unknown")
    expect(await resolveBox([], null, lookup)).toBe("unknown")
  })

  test("a failing step falls through to the next", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {})
    const broken: BoxLookup = {
      listed: () => {
        throw new Error("db gone")
      },
      contactBox: async () => {
        throw new Error("offline")
      },
      senderBox: (s) => (s === "news@example.net" ? "feed" : null),
    }
    try {
      expect(await resolveBox(["900"], "news@example.net", broken)).toBe("feed")
      expect(await resolveBox(["900"], "x@example.org", broken)).toBe("unknown")
    } finally {
      err.mockRestore()
    }
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
    expect(filesOnDisk(target)).toEqual([join("imbox", "123.eml")])
  })

  test("skips boxes that are not wanted", async () => {
    process.env.HEY_ARCHIVE_DIR = dir
    process.env.HEY_ARCHIVE_BOXES = "imbox"
    const feedRaw = RAW.replace("Pat@Example.org", "news@example.net")
    expect(await archiveRawMessage("124", feedRaw, { lookup })).toBeNull()
    expect(await archiveRawMessage("125", RAW, { lookup: none })).toBeNull() // unknown is not listed
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
    try {
      expect(await fetchRawMessage("456", ["topic-1"], none)).toBe(RAW)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith("/messages/456.text")
      expect(filesOnDisk(dir)).toEqual([join("unknown", "456.eml")])
    } finally {
      spy.mockRestore()
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
