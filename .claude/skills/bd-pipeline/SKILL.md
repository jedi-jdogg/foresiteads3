---
name: bd-pipeline
description: Refresh the Foresite BD pipeline — sweep Gmail (last 12 months), Calendly and the platform DB for prospects, rebuild the scored pipeline, and republish the BD Pipeline artifact. Use when Jonathan asks to update the pipeline, re-run the BD sweep, re-score prospects, or refresh the pipeline tool.
---

# Foresite BD pipeline refresh

The pipeline lives in two places: `bd-pipeline/data/seed.json` in this repo (the merged, scored snapshot) and the published artifact "Foresite BD Pipeline" (its `db` holds the live, edited state; its URL is recorded in `bd-pipeline/data/artifact.json`).

## 1. Sweep the sources

Run these as parallel background agents (each writes one JSON file into `bd-pipeline/data/sources/`). Today's date bounds the window at 12 months.

- **gmail_pipeline.json** — labels `A-Pipeline` (`Label_709454777408910987`) and `A - Hot Leads` (`Label_1277979622946254656`), `after:<12 months ago>`. Paginate fully, group threads by counterpart, read the newest thread per company with `get_thread` (PLAIN_TEXT), emit `{company, contacts[], source_label, referrer, summary, interest, deal_size_hint, stage, last_contact_date, last_from, owner, next_action, thread_ids[], thread_urls[]}`.
- **gmail_other.json** — labels `A - White Glove`, `A - GTM`, `B - Customer Success`, `A - Urgent` (deal-related only), `A-Platform`, `Consulting`, `Lindas`. Same shape plus `type` (prospect | customer | partner).
- **gmail_sent.json** — `in:sent` excluding the labels above, `from:calendly.com` notifications, and keyword sweeps (intro, pilot, proposal, partnership, white label, demo, pricing). Same shape plus `type`.
- **calendly.json** — `meetings-list_events` for user `https://api.calendly.com/users/EDCDIXDQGCAW3UXX`, last 12 months through year end, active and canceled, with `meetings-list_event_invitees` per event: `{event_types[], events[{start_time, name, status, invitees[{name,email,company_guess,qa}]}]}`.

Also refresh `data/foresite_platform.json` from the Foresite MCP (`database-query` on `tenants` joined to `subscriptions` and `plans`) and re-read the Google Sheet "Copy of Foresite AI Pipeline - Jonathan / Santiago" (Drive id `1PsJVWU9x_VYb25DfzOBc1vdxhtL1Cl0iXUheNCTUN4M`) into `data/sheet_pipeline.json` if it changed.

## 2. Rebuild

```
python3 bd-pipeline/scripts/build_seed.py
```

Writes `data/seed.json` and `reports/<date>-bd-pipeline.md`. Stage mapping, dedupe (by domain, then normalized name) and the priority formula are in the script and documented in `bd-pipeline/README.md`.

## 3. Republish and re-seed

1. Republish `bd-pipeline/pipeline.html` to the existing artifact URL with `files: {"seed.json": "bd-pipeline/data/seed.json"}` and the stored capabilities (omit `capabilities` to keep them).
2. Seed the database with `ArtifactData` (`batch` of `set` writes on collection `deals`, 50 per call). **Never overwrite a deal the team has edited in the tool**: list `deals` first; for an existing id only update fields that are empty in the db or strictly newer (`last_contact`, new `meetings`, new `thread_urls`), and keep `stage`, `priority`, `owner`, `next_action`, `due_date`, `notes` as they are in the db.
3. Commit the new sources, seed and report to the repo.

## 4. Report back

Give counts by priority, the top high-priority actions for the week, anything that moved stage since the last report, and the artifact link.
