/** The only site ingestion reads from. Event data is input: a URL elsewhere is refused, not fetched. */
export const HANDBOOK_ORIGIN = "https://handbook.gitlab.com"

export function isHandbookUrl(url: string): boolean {
    try {
        return new URL(url).origin === HANDBOOK_ORIGIN
    } catch {
        return false
    }
}

/**
 * One page, one URL: no #fragment or ?query, and a trailing slash, the way the handbook writes
 * its page URLs. Without this, ".../travel" and ".../travel/" would be stored as two pages, and
 * a "#section" in the event would end up in the middle of every chunk link.
 */
export function normalizeHandbookUrl(url: string): string {
    const u = new URL(url)
    u.hash = ""
    u.search = ""
    if (!u.pathname.endsWith("/")) u.pathname += "/"
    return u.toString()
}

/** The handbook redirected the request to another site. Fetching again goes to the same place. */
export class OffSiteRedirectError extends Error {
    constructor(
        readonly url: string,
        readonly finalUrl: string,
    ) {
        super(`${url} redirected outside the handbook, to ${finalUrl}`)
        this.name = "OffSiteRedirectError"
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
    // The check above is on the URL we asked for; a redirect may end somewhere else, and that
    // page's text must not be stored as handbook policy.
    if (!isHandbookUrl(response.url)) throw new OffSiteRedirectError(url, response.url)
    if (!response.ok) throw new PageFetchError(url, response.status)
    return response.text()
}
