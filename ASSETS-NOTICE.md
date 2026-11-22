# Asset licenses

WhoisPilot ships code, icons, artwork and a code dataset from different origins. This file says,
per asset, what you may do with it. The source code itself is MIT (see [LICENSE](LICENSE)).

| Asset | Origin | License |
|---|---|---|
| `src/**`, `tools/**`, `package.json`, `tsconfig.json` | original work for this project | MIT |
| `media/panel.html` | original work for this project | MIT |
| `media/icon.svg` (activity bar icon) | hand-authored SVG in this repository | MIT |
| `media/logo.png` (mascot) | commissioned/generated artwork; no third-party source file is bundled and no provenance metadata is recorded in the file | **no copyright claimed** — dedicated to CC0 1.0. See the note below. |
| README badges and language icons (remote images) | [shields.io](https://shields.io) (CC0 1.0), [skillicons.dev](https://skillicons.dev) (MIT), [readme-typing-svg](https://github.com/DenverCoder1/readme-typing-svg) (MIT) | none bundled — the README links these services; the marks they draw remain trademarks of their owners and are used only to identify languages |
| `media/screenshots/*.png` | screenshots of this extension running on demo code | MIT |
| `media/dataset/*.json` | verbatim code blocks from public repositories | MIT / Apache-2.0 / BSD / Unlicense, per block — see [DATASET-NOTICE.md](DATASET-NOTICE.md) |

## About the mascot (`media/logo.png`)

The cat mascot is artwork generated with an AI image tool and then scaled down to 256×256. That has
two consequences worth knowing before publishing:

- **No copyright is claimed on it, and none is granted to you by this repository.** In several
  jurisdictions (including the US Copyright Office's position on purely AI-generated output) material
  produced by a model without human authorship may not be protected by copyright at all. Since the
  project cannot own it, it cannot license it under MIT either. It is therefore dedicated to
  **CC0 1.0** to the extent any rights exist.
- **Trademark and character similarity are a separate question from copyright.** An AI tool can
  produce something close to a known character or brand. Only the person who publishes the asset can
  judge that risk; if the mascot resembles a third-party character, replace it before publishing.

If you want a mascot with airtight provenance, draw one yourself, commission it with a written
assignment, or take an asset whose license explicitly permits commercial and derivative use
(CC0, CC BY, MIT-licensed icon packs), and record the source here.

## README images

Badges, the animated tagline and the language icon strip are remote URLs (shields.io,
readme-typing-svg, skillicons.dev) — nothing is vendored, so there is no third-party file in this
repository to license. The VS Code Marketplace rejects **local** `.svg` references inside a README,
which is why the repository ships PNG screenshots (`media/screenshots`) rather than vector art.

## Attribution text you can copy

> Language icons from Simple Icons (CC0 1.0). Dataset blocks keep their original licenses,
> listed in DATASET-NOTICE.md. Mascot artwork: no copyright claimed, CC0 1.0.
