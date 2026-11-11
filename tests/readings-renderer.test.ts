import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LockedSectionCard, ReadingBlockView, ReadingSectionView } from "../src/components/reading-sections";
import { LOCKED_CTA } from "../src/readings/copy";
import type { LockedSection, ReadingBlock, ReadingSection } from "../src/readings/types";

/*
 * The renderer's failure mode is silent: a switch over block kinds that do not
 * exist returns null for every real block and the section renders empty. These
 * tests render against the REAL block union, so a vocabulary drift shows up as
 * a missing string rather than a blank page in production.
 */

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

function block(overrides: Partial<ReadingBlock> & { kind: ReadingBlock["kind"] }): ReadingBlock {
  return overrides as ReadingBlock;
}

function section(overrides: Partial<ReadingSection> = {}): ReadingSection {
  return {
    key: "overview",
    tier: "free",
    title: "The Year in One Breath",
    subtitle: "What this solar return year is about",
    blocks: [{ kind: "prose", text: "Sun in Leo, third house." }],
    facts: {},
    status: "generated",
    ...overrides,
  };
}

// ------------------------------------------------------------------ all five kinds

test("renderer: every real block kind renders its content", () => {
  const cases: Array<[ReadingBlock, string]> = [
    [block({ kind: "prose", text: "The year's keynote sounds here." }), "The year&#x27;s keynote sounds here."],
    [block({ kind: "callout", title: "Practice", text: "Twenty minutes a week." }), "Twenty minutes a week."],
    [block({ kind: "list", title: "Practices", items: ["Mind: three lines", "Body: a weekly ritual"] }), "Body: a weekly ritual"],
    [block({ kind: "keyValue", title: "Your chart", entries: [{ key: "Sun", value: "Leo 12°" }] }), "Leo 12°"],
    [
      block({ kind: "aspectTable", title: "Tightest", rows: [{ a: "Sun", b: "Moon", type: "square", orb: 1.2 }] }),
      "1.2°",
    ],
  ];

  for (const [value, expected] of cases) {
    const html = render(React.createElement(ReadingBlockView, { block: value, locale: "en" }));
    assert.ok(html.includes(expected), `${value.kind} renders ${JSON.stringify(expected)}, got: ${html.slice(0, 160)}`);
  }
});

test("renderer: the invented plan vocabulary renders nothing (unknown kinds are absent, not guessed)", () => {
  for (const kind of ["paragraph", "heading", "bullets", "highlight"]) {
    const html = render(
      React.createElement(ReadingBlockView, {
        block: { kind, text: "should not appear", items: ["nope"] } as unknown as ReadingBlock,
        locale: "en",
      }),
    );
    assert.equal(html, "", `${kind} must render nothing`);
  }
});

test("renderer: unknown kind inside a section is skipped without losing its siblings", () => {
  const html = render(
    React.createElement(ReadingSectionView, {
      locale: "en",
      section: section({
        blocks: [
          { kind: "paragraph", text: "from the old plan" } as unknown as ReadingBlock,
          { kind: "prose", text: "the real sentence" },
        ],
      }),
    }),
  );
  assert.equal(html.includes("old plan"), false);
  assert.ok(html.includes("the real sentence"));
});

// ------------------------------------------------------------------ section shape

test("renderer: section uses title, subtitle, blocks, closingQuestion and status", () => {
  const html = render(
    React.createElement(ReadingSectionView, {
      locale: "en",
      section: section({ closingQuestion: "What would you build there?" }),
    }),
  );
  assert.ok(html.includes("The Year in One Breath"), "title is rendered");
  assert.ok(html.includes("What this solar return year is about"), "subtitle is rendered");
  assert.ok(html.includes("What would you build there?"), "closingQuestion is rendered, not a cliffhanger field");
  assert.ok(html.includes('data-status="generated"'));
});

test("renderer: a failed section still shows its fallback blocks and says why", () => {
  const html = render(
    React.createElement(ReadingSectionView, {
      locale: "en",
      section: section({
        status: "failed",
        failureReason: "cost_ceiling: projected 12 MXN would exceed the free ceiling",
        blocks: [
          { kind: "prose", text: "This section couldn't be written just now." },
          { kind: "keyValue", title: "Your chart's facts", entries: [{ key: "sun", value: '{"sign":"leo"}' }] },
        ],
      }),
    }),
  );
  assert.ok(html.includes("couldn&#x27;t be written"), "fallback prose is visible");
  assert.ok(html.includes("Your chart&#x27;s facts"), "chart facts are still shown");
  assert.ok(html.includes("cost_ceiling"), "the reader is told why, not left guessing");
  assert.ok(html.includes('data-status="failed"'));
});

test("renderer: localized chrome follows the locale", () => {
  const es = render(
    React.createElement(ReadingSectionView, { locale: "es", section: section({ subtitle: undefined, closingQuestion: undefined }) }),
  );
  assert.ok(es.includes("De qué va este año de revolución solar"), "Spanish subtitle comes from copy.ts");

  const table = render(
    React.createElement(ReadingBlockView, {
      locale: "es",
      block: { kind: "aspectTable", rows: [{ a: "Sol", b: "Luna", type: "cuadratura", orb: 2 }] },
    }),
  );
  assert.ok(table.includes("Cuerpo") && table.includes("Orbe"), "table headers are translated");
});

// ------------------------------------------------------------------ locked cards

test("locked card: uses the pre-written teaser and the CTA that was never rendered", () => {
  const locked: LockedSection = { key: "moon", title: "The Moon: Emotional Weather", teaser: "The emotional weather you'll live in." };
  const html = render(React.createElement(LockedSectionCard, { locked, locale: "en" }));

  assert.ok(html.includes("The emotional weather you&#x27;ll live in."));
  assert.ok(html.includes(LOCKED_CTA.en), "LOCKED_CTA is finally rendered");
  assert.ok(html.includes('href="/pricing"'));
  assert.ok(html.includes('data-locked="moon"'));
  assert.equal(/filter:\s*blur/.test(html), false, "no blur: blurred means absent");
});

test("locked card: Spanish CTA", () => {
  const html = render(
    React.createElement(LockedSectionCard, {
      locked: { key: "nodes", title: "Los Nodos", teaser: "La dirección de crecimiento, y su precio." },
      locale: "es",
    }),
  );
  assert.ok(html.includes(LOCKED_CTA.es));
});
