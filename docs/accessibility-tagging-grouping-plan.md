# Accessibility Tagging Grouping Plan

Goal: make auto-detected accessibility tags deterministic, explainable, and safe for complex fixed-layout PDF pages. The current priority is to define and implement paragraph, list-item, and same-column grouping rules without breaking existing zoning/final XHTML workflows.

## Phase 1 — Same-Column Safety

Status: implemented for current heuristic and Docling merge paths.

Goal: prevent merging text from different columns.

Rules:

- Use horizontal overlap and center-X distance to decide if two candidates belong to the same column.
- Block vertical paragraph merge across different columns.
- Block same-line merge across different columns when the gap is larger than a normal text-run gap.
- Reuse the same column geometry for heuristic blocks and Docling layout items.

Expected output:

- No paragraph/list item crosses columns.
- Text at similar vertical positions but different horizontal columns stays separate.

## Phase 2 — Line Building

Status: implemented for current heuristic block flow.

Goal: normalize extracted blocks into reliable visual lines before paragraph/list logic.

Rules:

- Group blocks with similar baseline or y-center.
- Sort words/fragments left-to-right inside each line.
- Merge same-line fragments only when the gap is text-run-sized.
- Preserve font/style fragments inside the line.
- Do not classify logical paragraphs directly from raw blocks.
- Feed line candidates into paragraph merging instead of merging paragraphs directly from raw blocks.

Expected output:

- A clean `LineCandidate[]` model per page.
- Downstream paragraph and list rules operate on lines, not arbitrary raw blocks.

## Phase 3 — List Item Detection

Status: implemented for current heuristic line flow.

Goal: detect lists before paragraph merging.

Rules:

- Detect bullet markers: `•`, `◦`, `▪`, `-`, `–`, `—`.
- Detect numbered markers: `1.`, `1)`, `(1)`, `a.`, `a)`, `(a)`, `A.`, `A)`, `i.`, `i)`, `I.`.
- A list item starts when a line begins with a marker or has a bullet/number glyph near the left edge.
- Wrapped list continuation lines align to item text-left, not marker-left.
- A new `LI` starts when another marker appears at the same marker indent.
- Consecutive `LI` items with the same region/indent can later be grouped under parent `L`.
- Preserve marker lines during line building so bullet/number detection can happen before decorative filtering.
- Merge wrapped list continuation lines into the same `LI` before paragraph merging.

Expected output:

- List items become `LI`, not `P`.
- Wrapped list items remain one logical item.

## Phase 4 — Paragraph Merge Rules

Status: implemented for current heuristic line flow.

Goal: merge only true paragraph lines.

Rules:

- Merge only inside the same page, region, and column.
- Vertical gap must be within normal line-height range.
- Left alignment must be consistent.
- First-line indent is allowed.
- Hanging indent is allowed only for list-like structures.
- Right edge should be consistent for non-last lines.
- Final line may be shorter.
- A middle line that is much shorter and ends with terminal punctuation likely ends the paragraph.
- Use next-line height for vertical-gap checks instead of accumulated paragraph box height.
- Allow first-line indent within a bounded tolerance.
- Block paragraph merge when a short terminal line is followed by an uppercase/digit-starting new line.

Expected output:

- True multi-line paragraphs become one `P`.
- Separate paragraphs remain separate.

## Phase 5 — Blocker Rules

Status: implemented for current heuristic list/paragraph merge paths.

Goal: stop bad merges.

Blockers:

- Heading to body merge.
- Body to heading merge.
- Paragraph to caption/table/image/formula merge.
- Merge across separator lines.
- Merge across page header/footer/page number/artifact.
- Merge across strong instructional labels where they start a new logical unit, such as `IF`, `THEN`, `Example`, `Step`, `Note`, depending on geometry/context.
- Prevent isolated marker/very small content from being absorbed into paragraph/list merges.
- Apply blockers before list continuation and paragraph vertical merges.

Expected output:

- Instructional/card pages do not collapse into wrong large paragraphs.
- Headings, labels, captions, and body content remain separately taggable.

## Phase 6 — Region/Card Detection

Status: implemented as conservative internal region assignment for heuristic line flow. True colored/outlined-card detection from page graphics is not implemented yet.

Goal: group text only inside the correct visual region before paragraph/list rules.

Rules:

- Detect columns.
- Detect sidebars where possible.
- Detect colored/outlined cards where possible.
- Detect table/image/formula regions and avoid paragraph merging through them.
- Region order should drive reading order before line order.
- Assign internal region IDs from column clustering and large vertical gaps.
- Use heading/table/figure/formula/caption/artifact candidates as region boundaries for later body text.
- Block paragraph merges across region IDs.
- Allow tightly wrapped list continuations to merge even if the conservative region assignment splits them.

Expected output:

- Paragraph/list grouping happens only within a single visual region.
- Multi-card and multi-column pages become stable.

## Phase 7 — Debug Output

Goal: make wrong grouping explainable and fast to debug.

Status: implemented for current accessibility auto-detection runs.

Save per page:

- Raw blocks.
- Built lines.
- Detected columns.
- Detected regions.
- Final tags.
- Merge decisions.
- Blocker decisions.
- Candidate snapshots after each grouping stage.
- Docling candidate snapshots and Docling paragraph merge decisions when Docling is the active engine.

Suggested output path:

```text
storage/jobs/<jobId>/accessibility/debug/page-<pageNumber>.json
```

Expected output:

- We can inspect why two lines merged or did not merge.
- User-reported bad tags can be fixed with data, not screenshots alone.
- Debug JSON captures raw blocks, Docling candidates, line candidates, list candidates, region candidates, merge decisions, and final tags.

## Implementation Order

1. Finish Phase 1 same-column safety.
2. Implement Phase 2 line building.
3. Implement Phase 3 list item detection.
4. Implement Phase 4 paragraph merge rules.
5. Add Phase 5 blocker rules.
6. Add Phase 6 region/card detection.
7. Add Phase 7 debug JSON.

This order is intentional. Paragraph rules should not be implemented directly on raw blocks, otherwise the system will keep producing fragile merge behavior.
