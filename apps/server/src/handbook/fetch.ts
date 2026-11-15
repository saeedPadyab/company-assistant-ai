/** The only site ingestion reads from. Event data is input: a URL elsewhere is refused, not fetched. */
export const HANDBOOK_ORIGIN = "https://handbook.gitlab.com"

export function isHandbookUrl(url: string): boolean {
    try {
        return new URL(url).origin === HANDBOOK_ORIGIN
    } catch {
        return false
    }
}

export class PageFetchError extends Error {
    constructor(
        readonly url: string,
        readonly status: number,
    ) {
        super(`fetching ${url} failed: HTTP ${status}`)
        this.name = "PageFetchError"
    }
}

/**
 * Downloads one handbook page. Any status but 2xx throws: the handbook answers a missing
 * page with an error page, and that page must never be stored as policy text.
 */
export async function fetchPage(url: string): Promise<string> {
    if (!isHandbookUrl(url)) throw new Error(`not a handbook URL: ${url}`)
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new PageFetchError(url, response.status)
    return response.text()
}
