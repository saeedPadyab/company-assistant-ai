import * as cheerio from "cheerio"

/** The text under one heading of a handbook page. */
export interface PageSection {
    /** Heading path from h2 down, e.g. ["4. Procedures", "4.1 Travel related expenses"]. Empty before the first heading. */
    headings: string[]
    /** The id of the section's heading, used as the link's #anchor. null before the first heading. */
    anchor: string | null
    /** Paragraphs, list items and table rows as plain text, in page order. */
    blocks: string[]
}

export interface CleanPage {
    title: string
    /** Sections in page order; sections with no text are left out. */
    sections: PageSection[]
}

const HEADING_LEVELS: Record<string, number> = { h2: 2, h3: 3, h4: 4 }

// Inside the content area, these are page chrome, not handbook text.
const CHROME = [
    "script",
    "style",
    "noscript",
    "nav",
    "header.article-meta",
    ".td-page-meta",
    ".td-toc",
    // The "#" link Hugo adds to every heading; its text would end up in the heading.
    ".td-heading-self-link",
    "img",
    "svg",
    "button",
    "form",
].join(", ")

function normalize(text: string): string {
    return text.replace(/\s+/g, " ").trim()
}

/**
 * Turns a handbook page (the HTML Hugo serves) into its title and sections.
 * Only `.td-content` is read: the sidebar, top bar, breadcrumbs and footer are the same on
 * every page and would make every page look alike to the search.
 */
export function cleanPage(html: string): CleanPage {
    const $ = cheerio.load(html)
    const root = $(".td-content").first()
    if (root.length === 0) throw new Error("no .td-content element: not a handbook page")

    root.find(CHROME).remove()
    // The "This is a Controlled Document" banner says how the page may be edited, not what
    // the policy is. It is the same on every controlled page, so it would only add look-alike
    // chunks to the search. Other alerts (warnings, notes) are policy text and stay.
    root.find(".alert")
        .filter((_, el) => /controlled document/i.test($(el).find(".alert-heading").text()))
        .remove()
    // .text() glues the text of neighbouring elements: <div>Note</div><p>Fares</p> becomes
    // "NoteFares". A space after each block element keeps the words apart.
    root.find("p, div, br, li, dt, dd, blockquote, pre, h5, h6").after(" ")
    const title = normalize(root.find("h1").first().text()) || normalize($("title").text())
    root.find("h1").remove()

    const sections: PageSection[] = [{ headings: [], anchor: null, blocks: [] }]
    const path: { level: number; text: string }[] = []
    const current = () => sections[sections.length - 1]

    const walk = (parent: Parameters<typeof $>[0]) => {
        for (const el of $(parent).children().toArray()) {
            const tag = el.tagName.toLowerCase()
            const level = HEADING_LEVELS[tag]

            if (level) {
                // An h3 after an h4 closes the h4 and the previous h3: pop to the parent level.
                while (path.length > 0 && path[path.length - 1].level >= level) path.pop()
                path.push({ level, text: normalize($(el).text()) })
                sections.push({ headings: path.map((p) => p.text), anchor: $(el).attr("id") ?? null, blocks: [] })
            } else if (tag === "ul" || tag === "ol") {
                for (const li of $(el).children("li").toArray()) {
                    const text = normalize($(li).text())
                    if (text) current().blocks.push(`- ${text}`)
                }
            } else if (tag === "table") {
                for (const tr of $(el).find("tr").toArray()) {
                    const cells = $(tr)
                        .children("th, td")
                        .toArray()
                        .map((cell) => normalize($(cell).text()))
                    if (cells.some(Boolean)) current().blocks.push(cells.join(" | "))
                }
            } else if ($(el).find("h2, h3, h4").length > 0) {
                // A wrapper (div, section) with headings inside: go in, so its headings still start sections.
                walk(el)
            } else {
                const text = normalize($(el).text())
                if (text) current().blocks.push(text)
            }
        }
    }
    walk(root.get(0))

    return { title, sections: sections.filter((s) => s.blocks.length > 0) }
}
