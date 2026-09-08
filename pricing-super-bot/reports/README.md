# Reports

`pricing-bot analyze` writes three files per run, named `<date>-lindas-pricing.{html,csv,json}`:

- **html**: the dashboard (open in a browser, or publish as a Claude artifact)
- **csv**: one row per variant with current price, recommended price, score and flags. Importable into Shopify via the bulk editor after review.
- **json**: full scored dataset for downstream tooling
