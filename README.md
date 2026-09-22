# foresiteads3

Tooling for Foresite Ads clients.

- [`pricing-super-bot/`](pricing-super-bot/) — finds products on lindas.com that can take a price increase without losing demand, and produces a ranked report plus a review CSV. See its README for the model and how to run it. A Claude Code skill (`.claude/skills/pricing-super-bot`) documents how to refresh the data through the Shopify MCP tools.
- [`collateral/one-pager/`](collateral/one-pager/) — the Foresite sales two-pager: page one sells (AI Ads as step one, then Flows, Identities, TV and AI SEO/AEO, proof and pricing), page two explains how it works and links the founder videos. `template.html` (two pages) and `template-single.html` (one page with a compact video strip) are the editable sources; `render.mjs` inlines fonts and the logo and prints `Foresite_One_Pager.pdf` and `Foresite_One_Pager_Single_Page.pdf` with Playwright.
