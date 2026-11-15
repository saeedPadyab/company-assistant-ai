import { describe, expect, it } from "vitest"
import { cleanPage } from "./clean.js"

// Shaped like a page the handbook's Hugo theme serves, cut down to what the cleaner looks at.
const PAGE = `
<html><head><title>Travel | The GitLab Handbook</title></head>
<body>
  <nav class="td-navbar">Company Handbook Search</nav>
  <aside class="td-sidebar">Sidebar link that is on every page</aside>
  <main>
    <nav class="td-breadcrumbs">Handbook / Finance / Travel</nav>
    <div class="td-content">
      <h1>Global Travel Policy</h1>
      <header class="article-meta"><span>Last modified</span></header>
      <div class="alert alert-danger" role="alert"><div class="h4 alert-heading" role="heading">This is a Controlled Document</div>
      <p>Changes must be approved by a code owner.</div></p>
      <p>This policy applies to all team members.</p>
      <h2 id="1-policy">1. Policy<a class="td-heading-self-link" href="#1-policy">#</a></h2>
      <p>Book travel through Navan.</p>
      <ul><li>Economy class for flights under six hours.</li><li>Ask your manager first.</li></ul>
      <h3 id="airfare">Airfare</h3>
      <p>Book at least 14 days ahead.</p>
      <div class="alert alert-info" role="alert"><div class="alert-heading">Note</div><p>Refundable fares need approval.</p></div>
      <h4 id="class-of-service">Class of service</h4>
      <table><tr><th>Flight time</th><th>Class</th></tr><tr><td>Under 6 hours</td><td>Economy</td></tr></table>
      <h3 id="lodging">Lodging</h3>
      <div class="wrapper"><p>Hotels up to the city limit.</p><h4 id="long-stays">Long stays</h4><p>Ask Finance.</p></div>
      <h2 id="2-empty">2. Empty section</h2>
      <script>trackPageView()</script>
    </div>
  </main>
  <footer>Footer text</footer>
</body></html>`

describe("cleanPage", () => {
    const page = cleanPage(PAGE)

    it("takes the title from the h1", () => {
        expect(page.title).toBe("Global Travel Policy")
    })

    it("gives each heading a section with its full heading path and anchor", () => {
        expect(page.sections.map((s) => [s.headings.join(" › "), s.anchor])).toEqual([
            ["", null],
            ["1. Policy", "1-policy"],
            ["1. Policy › Airfare", "airfare"],
            ["1. Policy › Airfare › Class of service", "class-of-service"],
            ["1. Policy › Lodging", "lodging"],
            ["1. Policy › Lodging › Long stays", "long-stays"],
        ])
    })

    it("keeps list items and table rows apart", () => {
        const policy = page.sections[1]
        expect(policy.blocks).toEqual([
            "Book travel through Navan.",
            "- Economy class for flights under six hours.",
            "- Ask your manager first.",
        ])
        expect(page.sections[3].blocks).toEqual(["Flight time | Class", "Under 6 hours | Economy"])
    })

    it("finds headings inside wrapper elements", () => {
        expect(page.sections[4].blocks).toEqual(["Hotels up to the city limit."])
        expect(page.sections[5].blocks).toEqual(["Ask Finance."])
    })

    it("leaves out page chrome, heading self-links, scripts and empty sections", () => {
        const all = JSON.stringify(page)
        for (const noise of ["Sidebar", "Footer", "Handbook / Finance", "Search", "Last modified", "#", "trackPageView", "Empty section"]) {
            expect(all).not.toContain(noise)
        }
    })

    it("drops the Controlled Document banner but keeps other alerts", () => {
        const all = JSON.stringify(page)
        expect(all).not.toContain("Controlled Document")
        expect(all).not.toContain("code owner")
        expect(page.sections[0].blocks).toEqual(["This policy applies to all team members."])
        expect(page.sections[2].blocks).toEqual(["Book at least 14 days ahead.", "Note Refundable fares need approval."])
    })

    it("refuses a page without a content area, such as an error page", () => {
        expect(() => cleanPage("<html><body><main><h1>Page Not Found</h1></main></body></html>")).toThrow(/td-content/)
    })
})
