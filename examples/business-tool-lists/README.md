# Business Tool List Examples

This folder contains static, human-reviewable HTML examples of the business-level WebMCP candidates extracted from the saved public-site understanding runs. The files are intermediate understanding artifacts; they are not manifests and they do not execute site actions.

Each site file keeps four things together: the visitor goal, the minimum useful input, the expected result or state change, and the evidence/status that limits how confidently the candidate can be published. Repeated controls are folded into one business capability, while content lookup and external-write boundaries remain visible instead of being silently promoted to executable tools.

The extraction used the saved observations and control evidence in `acceptance/grundig/selector-fix.json` and `acceptance/phiphipirate/selector-fix.json`. The reference screenshot was used only after the independent extraction, as a final reconciliation check for the Grundig shortlist.

- [Grundig Bike business tools](./grundig-bike.html)
- [Phi Phi Pirate business tools](./phiphipirate.html)

The pages intentionally distinguish `directly-observed`, `template-only`, `inferred`, and `deferred`. A candidate marked `directly-observed` still needs merchant review before it becomes executable WebMCP code; a weaker status must not be compiled as if its contract had been tested.
