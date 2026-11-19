# S1-c staging QA — factual wheel and numerical facts

**Status: prepared, not executed.** This is the manual check for the slice merged as
`e606216` (PR #159), for the operator to run on staging. It is not evidence, not a
verdict, and not promotion approval.

**Why it exists.** `verify` on `e606216` passed, and the author suite is 816/816 on a
disposable PostgreSQL. Those are necessary and not sufficient for this slice: the two
worst defects found in review (issue #154) were invisible to every automated gate
until someone rendered the page — a paid edition that drew no wheel while claiming its
facts had never been saved, and label collisions across bands. Both are now covered by
tests, but the tests encode the cases we thought of. This document is how you check the
cases nobody thought of, on the deployment a reader would actually reach.

---

## 0. Before you start — three environment facts

Read this far enough to know whether QA can even run.

| Fact | Consequence |
|---|---|
| **Migration `0009` is already applied on staging.** It merged as part of #152/PR #156 on 2026-11-18T23:18Z, not with this slice. | Nothing to migrate for #159 — it adds no migration. If a chart save fails at QA time, the cause is *not* a missing `0009`; check that the running deployment includes S1-a rather than reaching for a migration. |
| **`READINGS_GENERATION_ENABLED` is still off.** | No Generate button, no AI controls, no LLM call. That is correct for this slice — QA is about the chart, not the interpretation. If you see a Generate control, stop: something changed that this checklist did not plan for. |
| **A chart that predates this slice legitimately has no facts.** | The "no wheel" states below are not bugs. Only a chart *saved after* `0009` was applied (2026-11-18) should ever draw a wheel. Do not treat the legacy behaviour as a failure, and do not "fix" it by backfilling. |

Staging is `https://solara-stg.vercel.app` per `scripts/deploy.sh`. UI language is a
cookie (`solara_locale`), not a URL — switch it with the header language control.

### Fixture matrix

Create these as real charts through `/create`, signed in, on staging: **four to create,
plus one you should already have.** Together they cover every geometry branch the slice
has.

| # | Chart | Return place | Expected wheel | What it is for |
|---|---|---|---|---|
| A | 2026, ordinary | New York (40.7°N) | Wheel, **Whole sign** | The happy path, English |
| B | 2026, same birth data | Chihuahua or Hermosillo (29–31°N) | Wheel, **Whole sign** | Same chart, different horizon: everything but the anchor must move |
| C | 2026, southern | Ushuaia (−54.8°) | Wheel, **Whole sign** | No mirroring; the wheel is not flipped below the equator |
| D | 2026, **high latitude** | Tromsø (69.65°N) | **No wheel**, omission notice | Never an invented horizon |
| E | 2026, legacy | *(do not create — use any chart saved before 2026-11-18)* | **No wheel**, absence notice | The legacy path |

Use a birth time you know and a birth place with a stable zone. Keep the birth data
identical across A, B, C and D so the only variable is the return place.

**One orientation consequence to know before you look:** the selected chart anchors the
whole wheel, and a base chart anchors on its Ascendant. For charts A, B and C that means
the Ascendant sits at **9 o'clock** on every one of them — by construction, not by
coincidence. So the wheel does *not* visibly "rotate" between two places; what moves is
everything else relative to that fixed anchor. Read check 11 with that in mind: the sign
ring, house cusps and body positions all shift, the Ascendant does not.

---

## 1. The chart renders the chart (checks 1–6)

For chart **A**, English, desktop.

- [ ] **1. A wheel is drawn at all.** Not the decorative sun-logo wheel — this one has sign
      names around the rim, twelve houses, and labelled points. If you see the decorative
      wheel, stop and report: that is the blocker from review, returning.
- [ ] **1b. It draws fourteen positions.** Ten bodies plus the Ascendant, Midheaven, True
      Node and South Node. Count the anchor dots. A short count means a saved fact was
      dropped silently, which the design forbids: omission must be *labelled*, not missing.
- [ ] **2. No "positions unavailable" notice.** Chart A was saved after `0009` was applied,
      so it has facts. If it says otherwise, the facts write or read failed.
- [ ] **3. The wheel agrees with the table.** Open the "saved calculation" disclosure below
      the wheel. Pick three points — the Sun, the Moon, and the Ascendant. For each, find
      the sign and degree in the table, then confirm the point sits in that sign's band on
      the wheel, at roughly that degree. You do not need exact degrees; you need *not
      visibly wrong*.
- [ ] **4. The Ascendant is at the 9 o'clock position.** By construction the Ascendant
      anchors the left of the wheel. If it is at the top, or the whole wheel looks rotated
      relative to what the sign ring says, that is a failure.
- [ ] **5. The disclosure names the house system it actually used.** Chart A must say
      *Whole sign*. It must never say Placidus — a whole-sign chart labelled Placidus is a
      correctness defect, not a copy nit.
- [ ] **6. The caveat is present and does not claim a decorative wheel.** Below the wheel
      there must be *"This is a preliminary calculation and a starting point for
      reflection—not a professionally verified chart."* It must **not** say the wheel is
      decorative, ornamental, or that it does not plot your placements — a real wheel is on
      screen. The specific string to watch for is **"Decorative wheel, not a plot of this
      chart"** (*"Rueda decorativa, no representa esta carta"*): it belongs only on the
      marketing surfaces. If it appears on a reading page, a decorative fallback was rendered.

## 2. The numerical table is complete and honest (checks 7–10)

Still chart A.

- [ ] **7. Ten bodies, with all four facts each.** Sun, Moon, Mercury, Venus, Mars, Jupiter,
      Saturn, Uranus, Neptune, Pluto — each with sign, degree, house number, and a motion
      word (direct / retrograde / stationary).
- [ ] **8. Twelve cusps, four angles and nodes.** House 1–12 cusps to four decimals; then
      Ascendant, Midheaven, True Node, South Node.
- [ ] **9. Natal reference is a separate table, visibly not the return positions.** Its
      title must say natal. The numbers should differ from the return placements for at
      least most bodies — if they are identical, the wrong source was read.
- [ ] **10. Two aspect groups, and only the cross group is annotated.** A return-aspects
      table and a return-to-natal table; every row in the second carries `(natal)`, and no
      row in the first does.

## 3. Orientation is real, not decorative (checks 11–12)

- [ ] **11. Compare A and B side by side.** Same birth data, different return place. The
      **Ascendant stays at 9 o'clock in both** — that is the anchor and it is where the
      slice's tests pin it. What must differ is everything relative to it: the sign ring is
      rotated, the twelve house cusps land at different screen angles, and the Sun sits in a
      different part of its sign. If the two wheels are pixel-identical, the return place is
      not reaching the calculation.
- [ ] **12. Chart C is not mirrored.** A southern-hemisphere wheel is not flipped: the
      Ascendant is still on the left and the signs still run in the same rotational
      direction as chart A. A mirror image here means the projection is using hemisphere
      sign conventions it should not.

## 4. Absence is explained, never faked (checks 13–16)

- [ ] **13. Chart D draws no wheel.** High latitude: no Ascendant exists, so there is no
      horizon to anchor. Expect no wheel graphic, and a sentence where the wheel would be:
      *"There is no wheel for this chart. The numerical table below is the authoritative
      reference."* (Spanish: *"No hay rueda para esta carta. La tabla numérica de abajo es la
      referencia autoritativa."*)
- [ ] **14. Chart D states what is missing and why.** The notice list should contain, in
      substance: *"The Ascendant and houses are omitted at high latitudes until the
      calculation is independently verified. No horizon has been invented, so no wheel is
      shown; the positions below are still the calculated ones."* It must **not** claim your
      data was incomplete, and there must be no wheel with a plausible-looking Ascendant
      invented to fill the gap. **This is the failure mode that matters most: an invented
      horizon looks completely normal.**
- [ ] **15. Chart D still shows its ten bodies in the table.** The notice says the positions
      below are still the calculated ones — so they must be. Omitting the horizon must not
      take the ten placements, the nodes or the aspects with it. A high-latitude chart with
      an empty table is a defect even though "no wheel" is correct.
- [ ] **16. Chart E (legacy) draws no wheel and says so without diagnosing.** Expect: no
      wheel, the four existing placement cards, and *"Complete saved positions are not
      available for this chart, so no chart wheel is shown. Nothing is guessed or redrawn to
      fill the gap; save a new chart to get one."* Two things to check beyond the wording:
      it must **not** assert a cause ("saved before positions were recorded") — an
      unreadable row, a failed hash and a size rejection all produce this same state — and
      the sentence where the wheel would be must **not** point at a numerical table, because
      a legacy chart has none.

## 5. Language (checks 17–20)

- [ ] **17. Switch the UI to Spanish on chart A.** Every piece of chrome is Spanish: the
      notices, the table headings, the motion words (`directo`, `retrógrado`), the house
      labels (`Casa 8`), and the sign names (`Géminis`, `Júpiter`, `Plutón`, `Medio Cielo`).
- [ ] **18. Nothing English leaks into the Spanish table.** In particular watch for
      `retrograde`, `stationary`, `House`, and `direct` as a standalone word inside a
      Spanish row. `directo` is correct; `direct` is not.
- [ ] **19. The wheel's accessible name is in the language its text is in.** With a screen
      reader (VoiceOver, NVDA, or the browser's accessibility inspector), the image should
      be announced as one named image — `Carta factual de …` — with a description naming
      the house system and pointing at the numerical table. The surrounding notices should
      still be read as Spanish too, since Spanish is the interface language here. The wheel
      declares its own language; this check is that the declaration and the interface do not
      disagree. In the English interface (chart A) the same must hold with `Factual chart
      for …`.

**Check 19b — the divergent case: English interface, a Spanish saved edition.**

The case the language fix was written for, and the one most likely to be missed, because
the page looks completely fine.

- [ ] **19b. The divergent pair.** First, note what this is **not**: a plain chart is
      *notes*, not a saved document, and its content locale follows the interface — switch
      the UI to English on a plain Spanish-viewed chart and you correctly get an English
      wheel on an English page. That is not the case and cannot be made into it.
      Divergence requires a **saved interpretation** (a `?document=` or paid edition)
      created in Spanish and then viewed with the interface in English.

      With generation off on staging you may not be able to create one. If no Spanish saved
      edition exists, record **`n/a` with that reason** and do not approximate it with a base
      chart — that would test nothing. The automated protection for this case is the paid
      integration test asserting the wheel's effective language under the opposite locale;
      this check is only whether the real deployment agrees.

      Expected, and each half matters:
      - the **wheel** — title, description, sign names, motion words, omissions — is
        Spanish (`Carta factual de …`, `Medio Cielo`, `Géminis`);
      - the **notices around it** — the preliminary-calculation caveat, the house-system and
        omission sentences — are **English**, because they belong to the interface;
      - the saved-calculation table matches the wheel, since it is the same saved content.

      A Spanish wheel in an English page is correct if — and only if — the wheel declares its
      own language. Confirm in the accessibility inspector that the wheel's container
      carries `lang="es"` and that the notices are outside it. If the Spanish wheel carries
      no declaration, a screen reader pronounces Spanish sign names with English phonetics:
      that is the concrete defect this check catches, and it is invisible on screen.

- [ ] **20. The switch itself is not a write.** Note the chart's URL, switch language a few
      times, reload. The rendered chart must not change, no new edition may appear, and the
      page must not offer to regenerate anything.

## 6. The layout holds (checks 21–24)

Resize or use device emulation. The wheel is sized by the reading page only — the rest of
the site is untouched by this slice, which is worth confirming rather than assuming.

**The numbers you should see** (these are asserted in the browser suite, so a mismatch is a
real finding, not an aesthetic quibble):

| Viewport | Reading-page wheel | Track |
|---|---|---|
| 1281 / 900 / 561px, 1× | **360px**, square | 380px |
| 560px, 1× (the breakpoint) | **280px** | single column |
| 390px, 2× (phone, 200% density) | **280px** | reflows to one column |

- [ ] **21. At 390px wide (phone), everything is on screen.** No sideways scrolling, no
      label hanging off the edge of the drawing, no overlap between the side-by-side
      columns — they collapse to one, with the wheel below the copy. The wheel is 280px and
      square; the table stacks below it.
- [ ] **22. No two point labels overlap, at any width.** This is the check the review
      caught us on twice. Look specifically at the crowded arc for clusters — the Ascendant
      and any point within a few degrees of it are the usual culprits. Between two labels
      you should see background, not glyph-on-glyph.
      **Related, and deliberate:** if a point genuinely cannot be labelled without colliding,
      the design omits its *label*, not its position. So you may see a small anchor dot with
      no text beside it, and a thin leader line where a label had to be nudged off its
      anchor. That is the intended honest outcome, not a bug — what would be a bug is a
      missing **dot** (a position quietly dropped) or text drawn on top of text. Check at the
      tightest width you can: the smaller the wheel, the more likely the omitted path is
      exercised.
- [ ] **23. `/sample` is unchanged.** The marketing sample page still shows its *decorative*
      wheel, unchanged in size — **250px at desktop, 190px on a phone-width viewport**, with
      its 270px second track above the phone breakpoint. Those exact numbers are pinned by a
      test; if the drawing grew, scope leaked from the reading page into marketing.
- [ ] **24. Home and `/usage-guide` still show the decorative wheel.** Same reasoning:
      `AstroWheel` stays only where it is ornamental (`/`, `/sample`, `/usage-guide`) and is
      never a stand-in for a chart. If a chart anywhere renders something that looks like
      the decorative wheel, that is the review blocker returning.

## 7. Paid editions (checks 25–27)

Skip if you have no paid edition on staging; note the skip rather than substituting a free
chart.

- [ ] **25. A paid edition draws a Placidus wheel.** This is the blocker from review: the
      page used to look for facts in the hashed chart summary, not find them, and claim the
      positions had never been saved. It must now draw the wheel and label the house system
      *Placidus*.
- [ ] **26. The paid wheel matches its own pinned snapshot**, not a fresh calculation. Hard
      to prove by eye; the practical check is that it is internally consistent with the
      paid edition's own table and that its house system says Placidus rather than whole
      sign.
- [ ] **27. Everything else about the paid output is unchanged.** Same interpreted text,
      same sections, same download. This slice claims it did not touch paid content; confirm
      rather than trust.

## 8. Nothing was generated (checks 28–29)

- [ ] **28. No provider call happened during any of the above.** Viewing, reloading,
      switching language, resizing and downloading must not have started a generation,
      consumed an allowance, or changed a saved edition. If you have access to the
      observability surface, confirm zero generation events across the whole session.
- [ ] **29. The PDF still downloads and still matches.** Download it from chart A. It is
      allowed to be **unchanged by this slice** — the PDF wheel is the *next* issue (#155,
      S1-d), not this one. What must be true is that it still downloads, still matches the
      saved edition, and did not start carrying a wheel it cannot yet render faithfully.

---

## Recording the result

For each check: `pass`, `fail`, or `n/a` with a one-line reason. Two things are worth more
than a tick: **the chart ID** you used, and **a screenshot** for anything visual — label
collisions and invented horizons are hard to prove from prose.

If anything fails, this is a staging defect and not a merge to promote. The wheel is the
chart: a wrong or invented position is worse than an absent one, and the whole slice is
built on that premise.

## What this does not cover

- **No accessibility audit.** Check 19 is a language check on one component, not a screen-
  reader pass over the page; that remains #92 and the a11y rows in
  `docs/setup/07-platform-validation.md`.
- **No genuine generation QA.** Generation stays off; the interpretation journey is S4-a.
- **No PDF wheel expectations.** That is #155.
- **No performance measurement.** The element budget is asserted in tests, not here.
- **No hosted qualification claim.** A green staging QA is one gate, not readiness.
