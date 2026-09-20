import { listApiKeysForAccount } from "@/data/api-keys"
import { requireShell } from "../shell-data"
import { KeyManager } from "./key-manager"

export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"

/**
 * This page is explicitly request-time and uncached. A minted key is revealed
 * once by the client owner and must never be copied into a prerender or page
 * cache; the server stores only its prefix and hash.
 */
export default async function KeysPage() {
  const { account } = await requireShell()
  const keys = await listApiKeysForAccount(account.id)

  return (
    <main className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Create credentials for projects that start calls through the API.
        </p>
      </header>
      <KeyManager keys={keys} />
    </main>
  )
}
