# github-contrib-globe-badge

A daily-updating GitHub contribution analytics badge showing where the owners of repositories you contribute to are located. Click the badge to open an **interactive Cobe globe** on GitHub Pages.

[![My contributions badge](https://raw.githubusercontent.com/hummern/github-contrib-globe-badge/main/badge.gif)](https://hummern.github.io/github-contrib-globe-badge/)

This project builds on [shuding/cobe](https://github.com/shuding/cobe), the WebGL globe library that renders the interactive page — cobe was the source and inspiration for this badge, though this repository's code, workflow, and generated assets have since diverged into a standalone tool.

## What it shows

The animated GIF badge shows a rotating dotted world map with contribution-location markers, commit counts, and each location's percentage of tracked contributions. The globe completes one seamless rotation per loop. Clicking the badge opens the interactive version, where the globe can be dragged and zoomed. The interactive globe uses the same daily-generated `data.json` as the badge and displays the Cobe world map with live marker labels.

## How it works

1. GitHub Actions searches commits authored by the configured GitHub user since 2023.
2. For each commit's repository, the generator resolves the true origin repository — following GitHub's fork `source` field, and falling back to a commits-search lookup (picking the oldest repository by creation date) to catch repositories that duplicate another repo's commit history without being a registered GitHub fork. Origins are cached per repository so this only runs once per distinct repository, not once per commit.
3. Commits are grouped by the origin repository's owner, and each owner's public GitHub profile location is geocoded with OpenStreetMap Nominatim.
4. The generator writes `badge.gif` for the animated profile badge and `data.json` for the interactive page.
5. GitHub Pages serves the root `index.html`, which loads Cobe in the browser and renders the interactive globe.
6. A daily workflow (`.github/workflows/badge-update.yml`) regenerates and commits the badge and shared analytics data.

## Adding the badge to a profile README

Use the linked-image Markdown below. Replace `hummern` with your GitHub username if you fork the repository:

```markdown
[![My contributions badge](https://raw.githubusercontent.com/hummern/github-contrib-globe-badge/main/badge.gif)](https://hummern.github.io/github-contrib-globe-badge/)
```

The outer link opens the interactive GitHub Pages globe in a new browser tab when the profile visitor clicks the badge link.

## Repository layout

```text
.
├─ index.html                         # interactive Cobe globe served by GitHub Pages
├─ data.json                          # generated contribution data consumed by index.html
├─ badge.gif                          # generated animated profile badge
├─ badge/generate-badge.js            # badge and analytics-data generator
└─ .github/workflows/badge-update.yml # daily generation and commit workflow
```

## Customising

The contribution date range is controlled by the `author-date:>2023-01-01` query in `badge/generate-badge.js`. The interactive page imports Cobe from jsDelivr and can be customised through the globe options and page styles in `index.html`.

## Development

```bash
npm install
GITHUB_ACTOR=hummern node badge/generate-badge.js
```

The generator writes both `badge.gif` and `data.json`. GitHub Pages is configured to serve the repository's `main` branch root at:

<https://hummern.github.io/github-contrib-globe-badge/>

## Credits

The interactive globe rendering is powered by [Cobe](https://github.com/shuding/cobe) by [Shu Ding](https://github.com/shuding). This repository was originally created as a fork of that project and has since grown into an independent profile-badge generator.

## License

MIT
