---
name: bd-pipeline
description: Refresh the Foresite BD pipeline — sweep Gmail (last 12 months), Calendly and the platform DB for prospects, rebuild the scored pipeline, and republish the BD Pipeline artifact. Use when Jonathan asks to update the pipeline, re-run the BD sweep, re-score prospects, or refresh the pipeline tool.
---

# Foresite BD pipeline refresh

The pipeline lives in two places: `bd-pipeline/data/seed.json` in this repo (the merged, scored snapshot) and the published artifact "Foresite BD Pipeline" (its `db` holds the live, edited state; its URL is recorded in `bd-pipeline/data/artifact.json`).

## 1. Sweep the sources

Run these as parallel background agents (each writes one JSON file into `bd-pipeline/data/sources/`). On a **refresh** (the normal case), sweep only the days since `last_refresh` in `data/artifact.json` plus a day of overlap and write `delta_<name>.json`; `scripts/merge_delta.py` folds the deltas into the 12-month files and removes them. Run a full 12-month sweep only when the source files are missing. Use the `sonnet` model for the sweep agents; they are tool-heavy and it keeps usage within limits.

Gmail gotchas: `label:Label_<id>` does not work on this account, use name syntax (`label:a-pipeline`, `label:a---hot-leads`, `label:a---white-glove`, `label:a---urgent`, `label:a---gtm`, `label:b---customer-success`, `label:a-platform`). Labels sit on messages, so a recently active thread may carry no recent labeled message: for the pipeline labels, also search counterpart addresses without the label. Calendly notices go to the chiefcxofficer.com inbox, so meetings come from the Calendly API, not Gmail. Calendly `page_token` is rejected; paginate by advancing `min_start_time`.

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

1. Before rebuilding, copy the current `data/seed_docs/` aside (it is what the db was last seeded with) and dump the live db: `ArtifactData list deals` with `out_dir` (note each doc's version from the listing).
2. `python3 scripts/seed_docs.py --existing-dir <db dump>/deals --last-seed-dir <copy>/deals`. A db doc identical to the last seed is unedited and takes the fresh build; an edited doc keeps its `stage`, `priority`, `owner`, `next_action`, `due_date`, `notes` and only gains newer `last_contact`, `meetings`, `thread_urls`.
3. Diff `data/seed_docs/deals/*.json` against the dump: write changed docs with `ArtifactData batch` (`set`, pinned with `if_version` from the listing, 50 per call), new docs unpinned, and `delete` ids that vanished (merged duplicates), pinned.
4. Republish `bd-pipeline/pipeline.html` to the artifact URL with `files: {"seed.json": "bd-pipeline/data/seed.json"}`; omit `capabilities` to keep them.
5. Update `last_refresh` in `data/artifact.json`; commit sources, seed, report and push.

## 4. Report back

Give counts by priority, the top high-priority actions for the week, anything that moved stage since the last report, and the artifact link.
