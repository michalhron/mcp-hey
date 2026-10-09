import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveDir, archiveRawMessage, fetchRawMessage } from "../archive"
import { heyClient } from "../hey-client"

const RAW = [
  "From: sender@example.com",
  "Message-ID: <abc@example.com>",
  "Subject: Test",
  "",
  "Hello.",
].join("\r\n")

let dir: string
const saved = process.env.HEY_ARCHIVE_DIR

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hey-archive-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (saved === undefined)
    Reflect.deleteProperty(process.env, "HEY_ARCHIVE_DIR")
  else process.env.HEY_ARCHIVE_DIR = saved
})

describe("archive", () => {
  test("off when HEY_ARCHIVE_DIR is unset or empty", async () => {
    Reflect.deleteProperty(process.env, "HEY_ARCHIVE_DIR")
    expect(archiveDir()).toBeNull()
    process.env.HEY_ARCHIVE_DIR = "  "
    expect(archiveDir()).toBeNull()
    expect(await archiveRawMessage("123", RAW)).toBeNull()
  })

  test("writes {id}.eml with mode 600 in a folder with mode 700", async () => {
    const target = join(dir, "sub")
    process.env.HEY_ARCHIVE_DIR = target
    const path = await archiveRawMessage("123", RAW)
    expect(path).toBe(join(target, "123.eml"))
    expect(readFileSync(join(target, "123.eml"), "utf8")).toBe(RAW)
    expect(statSync(join(target, "123.eml")).mode & 0o777).toBe(0o600)
    expect(statSync(target).mode & 0o777).toBe(0o700)
    expect(readdirSync(target)).toEqual(["123.eml"])
  })

  test("never overwrites an existing file", async () => {
    process.env.HEY_ARCHIVE_DIR = dir
    writeFileSync(join(dir, "123.eml"), "original")
    expect(await archiveRawMessage("123", RAW)).toBeNull()
    expect(readFileSync(join(dir, "123.eml"), "utf8")).toBe("original")
  })

  test("rejects ids that are not plain message ids", async () => {
    process.env.HEY_ARCHIVE_DIR = dir
    for (const id of ["../123", "12/3", "abc", ""]) {
      expect(await archiveRawMessage(id, RAW)).toBeNull()
    }
    expect(readdirSync(dir)).toEqual([])
  })

  test("fetchRawMessage archives what it fetched, without a second request", async () => {
    process.env.HEY_ARCHIVE_DIR = dir
    const spy = spyOn(heyClient, "fetchHtml").mockResolvedValue(RAW)
    try {
      expect(await fetchRawMessage("456")).toBe(RAW)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith("/messages/456.text")
      expect(existsSync(join(dir, "456.eml"))).toBe(true)
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
      expect(await fetchRawMessage("789")).toBe(RAW)
    } finally {
      spy.mockRestore()
      err.mockRestore()
    }
  })
})
