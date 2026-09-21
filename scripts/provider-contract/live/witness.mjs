import { createInterface } from "node:readline/promises"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function decodeBrowserClaims(token) {
  const parts = token.split(".")
  if (parts.length < 2) throw new Error("Daily browser token is invalid")
  let value
  try {
    value = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  } catch {
    throw new Error("Daily browser token claims are invalid", { cause: null })
  }
  const properties = value?.properties ?? value
  if (
    !Number.isSafeInteger(properties?.exp) ||
    typeof properties?.eject_at_token_exp !== "boolean" ||
    typeof properties?.is_owner !== "boolean" ||
    typeof properties?.room_name !== "string" ||
    properties.room_name.length === 0
  ) {
    throw new Error("Daily browser token is missing bounded claims")
  }
  return {
    expiresAtEpochSeconds: properties.exp,
    ejectAtTokenExpiry: properties.eject_at_token_exp,
    isOwner: properties.is_owner,
    roomScoped: true,
  }
}

export async function createFileOperatorWitness({
  input = process.stdin,
  output = process.stderr,
  makeDirectory = () => mkdtemp(join(tmpdir(), "duplexd-provider-proof-")),
} = {}) {
  const directory = await makeDirectory()
  await chmod(directory, 0o700)
  const readline = createInterface({ input, output })
  let currentPath = null

  async function expect(caseId, event) {
    const expected = `${caseId}:${event}`
    const answer = await readline.question(
      `operator witness required; type ${expected} after observing it: `
    )
    if (answer.trim() !== expected)
      throw new Error("operator witness did not match active case")
    return new Date().toISOString()
  }

  return {
    directory,
    async publishJoin(caseId, value) {
      currentPath = join(directory, `${caseId}-join.html`)
      const room = JSON.stringify(value.dailyRoom).replaceAll("<", "\\u003c")
      const token = JSON.stringify(value.dailyToken).replaceAll("<", "\\u003c")
      const html = `<!doctype html><meta name="referrer" content="no-referrer"><title>Stage A provider proof</title><script>const room=${room};const token=${token};const url=new URL(room);url.searchParams.set("t",token);location.replace(url.href)</script>`
      await writeFile(currentPath, `${html}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      })
      output.write(`open the volatile browser join page: ${currentPath}\n`)
    },
    expect,
    async clearCase() {
      if (currentPath !== null) await rm(currentPath, { force: true })
      currentPath = null
    },
    async preserveContainment(value) {
      const path = join(directory, "containment.json")
      await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      })
      output.write(
        `cleanup is blocked; volatile containment record preserved at ${path}\n`
      )
      return path
    },
    cancelInput() {
      readline.close()
    },
    async close({ destroy }) {
      readline.close()
      if (destroy) await rm(directory, { recursive: true, force: true })
    },
  }
}
