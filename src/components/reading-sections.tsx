import type { CSSProperties, ReactElement } from "react";
import type { Locale } from "@/lib/i18n";
import type { LockedSection, ReadingBlock, ReadingSection } from "@/readings/types";
import { LOCKED_CTA, SECTION_SUBTITLES } from "@/readings/copy";

/**
 * The section renderer (#106).
 *
 * Two contracts, both from `schemas.ts`:
 *   1. Exhaustive over the five block kinds that exist
 *      (`prose | callout | list | keyValue | aspectTable`).
 *   2. An UNKNOWN kind renders nothing — never throws, never guesses. That is
 *      what lets the block vocabulary grow without a coordinated deploy.
 *
 * Presentation only. No data access, no tier decisions: what to show was decided
 * when the document was generated (`sectionsForTier`), and a document only ever
 * contains sections the reader is entitled to see. `lockedSections` is a
 * separate list of previews, rendered by `LockedSectionCard` below.
 */

// ------------------------------------------------------------------ styles

const proseStyle: CSSProperties = { margin: "0 0 16px", lineHeight: 1.85, fontSize: 14.5, color: "#4a423c" };
const blockTitleStyle: CSSProperties = {
  display: "block",
  margin: "0 0 10px",
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: ".02em",
  color: "#3c342f",
};
const listStyle: CSSProperties = { margin: "0 0 18px", paddingLeft: 20, lineHeight: 1.8, fontSize: 14.5, color: "#4a423c" };
const tableStyle: CSSProperties = { width: "100%", borderCollapse: "collapse", margin: "0 0 20px", fontSize: 13 };

// ------------------------------------------------------------------ blocks

function Prose({ text }: { text: string }): ReactElement {
  return <p style={proseStyle}>{text}</p>;
}

function Callout({ title, text }: { title?: string; text: string }): ReactElement {
  return (
    <div className="notice" style={{ margin: "0 0 18px" }}>
      {title ? <span style={blockTitleStyle}>{title}</span> : null}
      <span>{text}</span>
    </div>
  );
}

function Bullets({ title, items }: { title?: string; items: string[] }): ReactElement {
  return (
    <div style={{ margin: "0 0 18px" }}>
      {title ? <span style={blockTitleStyle}>{title}</span> : null}
      <ul style={{ ...listStyle, margin: 0 }}>
        {items.map((item, index) => <li key={index}>{item}</li>)}
      </ul>
    </div>
  );
}

function KeyValue({ title, entries }: { title?: string; entries: { key: string; value: string }[] }): ReactElement {
  return (
    <div style={{ margin: "0 0 18px" }}>
      {title ? <span style={blockTitleStyle}>{title}</span> : null}
      <div className="detail-list">
        {entries.map((entry, index) => (
          <div className="detail-row" key={index}>
            <span>{entry.key}</span>
            {/* Values can be long JSON excerpts (document.ts:factsToEntries). */}
            <span style={{ textAlign: "right", overflowWrap: "anywhere", maxWidth: "60%" }}>{entry.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AspectTable({
  title,
  rows,
  locale,
}: {
  title?: string;
  rows: { a: string; b: string; type: string; orb: number }[];
  locale: Locale;
}): ReactElement {
  const es = locale === "es";
  return (
    <div style={{ margin: "0 0 20px" }}>
      {title ? <span style={blockTitleStyle}>{title}</span> : null}
      <table style={tableStyle}>
        <thead>
          <tr>
            {[es ? "Cuerpo" : "Body", es ? "Con" : "With", es ? "Aspecto" : "Aspect", es ? "Orbe" : "Orb"].map(heading => (
              <th
                key={heading}
                scope="col"
                style={{ textAlign: "left", padding: "7px 9px", borderBottom: "1px solid #ece2da", fontWeight: 700, color: "#a79a91" }}
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td style={{ padding: "7px 9px", borderBottom: "1px solid #f4ece6" }}>{row.a}</td>
              <td style={{ padding: "7px 9px", borderBottom: "1px solid #f4ece6" }}>{row.b}</td>
              <td style={{ padding: "7px 9px", borderBottom: "1px solid #f4ece6" }}>{row.type}</td>
              <td style={{ padding: "7px 9px", borderBottom: "1px solid #f4ece6" }}>{row.orb}°</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One block. The switch is exhaustive over `ReadingBlock`, so adding a kind to
 * the union is a type error here rather than a silently blank section.
 *
 * The `default` arm is deliberate and not dead code: documents are persisted
 * JSON that may have been written by a newer build than the one rendering them
 * (rollback), and a kind added on a branch will arrive before this file knows it.
 */
export function ReadingBlockView({ block, locale }: { block: ReadingBlock; locale: Locale }): ReactElement | null {
  switch (block.kind) {
    case "prose":
      return <Prose text={block.text} />;
    case "callout":
      return <Callout title={block.title} text={block.text} />;
    case "list":
      return <Bullets title={block.title} items={block.items} />;
    case "keyValue":
      return <KeyValue title={block.title} entries={block.entries} />;
    case "aspectTable":
      return <AspectTable title={block.title} rows={block.rows} locale={locale} />;
    default:
      return null;
  }
}

// ------------------------------------------------------------------ sections

/**
 * A whole section. Every property of `ReadingSection` is used somewhere here —
 * that is the check that the renderer is reading the real shape and not a
 * remembered one.
 */
export function ReadingSectionView({ section, locale }: { section: ReadingSection; locale: Locale }): ReactElement {
  const subtitle = section.subtitle ?? SECTION_SUBTITLES[section.key][locale];
  return (
    <section className="panel" data-section={section.key} data-status={section.status}>
      <div className="eyebrow">{section.title}</div>
      {subtitle ? <p className="small muted" style={{ margin: "6px 0 18px" }}>{subtitle}</p> : null}

      {section.blocks.map((block, index) => (
        <ReadingBlockView block={block} key={index} locale={locale} />
      ))}

      {section.closingQuestion ? (
        <p style={{ margin: "18px 0 0", fontStyle: "italic", color: "#8a6a56", fontSize: 14 }}>
          {section.closingQuestion}
        </p>
      ) : null}

      {/*
       * A failed section is never silent. `document.ts:buildReadingDocument` already
       * substituted fallback prose + a chart-facts table, so the reader sees real
       * data; the footer says why the words are missing without leaking internals.
       */}
      {section.status === "failed" ? (
        <p className="small muted" style={{ marginTop: 14 }}>
          {section.failureReason
            ? `${locale === "es" ? "Contenido no disponible" : "Content unavailable"} · ${section.failureReason}`
            : (locale === "es" ? "Contenido no disponible" : "Content unavailable")}
        </p>
      ) : null}
    </section>
  );
}

/**
 * A paid section the reader has not unlocked.
 *
 * "Blurred means absent" (`types.ts`): the prose was never generated, so there is
 * nothing to blur. The card shows the hand-written bilingual teaser from
 * `copy.ts:LOCKED_TEASERS` — not a truncated first paragraph, which cuts
 * mid-sentence — and the CTA the codebase has defined and never rendered.
 */
export function LockedSectionCard({ locked, locale }: { locked: LockedSection; locale: Locale }): ReactElement {
  return (
    <section className="panel" data-locked={locked.key} style={{ position: "relative" }}>
      <div className="eyebrow">{locked.title}</div>
      <p style={{ margin: "12px 0 18px", lineHeight: 1.8, fontSize: 14.5, color: "#6f665f" }}>{locked.teaser}</p>
      <a className="button button-small" href="/pricing">
        {LOCKED_CTA[locale]}
      </a>
    </section>
  );
}
