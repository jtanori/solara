import type { CSSProperties, ReactElement } from "react";
import { localeName, type Locale } from "@/lib/i18n";
import type { ReadingBlock } from "@/readings/types";
import type { DisplaySection, ReadingContent, SectionPreview } from "@/readings/presentation";
import { aspectHeadings, AVAILABILITY_COPY, editionTitle, NOTICE_COPY, PREVIEW_COPY } from "@/readings/presentation-copy";
import { savedDate } from "@/readings/presentation-format";

const proseStyle: CSSProperties = { margin: "0 0 16px", lineHeight: 1.85, fontSize: 14.5, color: "#4a423c", whiteSpace: "pre-line", overflowWrap: "anywhere" };
const titleStyle: CSSProperties = { display: "block", margin: "0 0 10px", fontSize: 14, fontWeight: 700, color: "#3c342f" };
const cellStyle: CSSProperties = { padding: "8px", textAlign: "left", borderBottom: "1px solid #e4d9cf", overflowWrap: "anywhere" };

/** HTML adapter of the validated five-block vocabulary. Unknown future kinds are absent. */
export function ReadingBlockView({ block, locale }: { block: ReadingBlock; locale: Locale }): ReactElement | null {
  switch (block.kind) {
    case "prose": return <p style={proseStyle}>{block.text}</p>;
    case "callout": return <aside className="notice" style={{ ...proseStyle, padding: 16 }}>{block.title && <strong style={titleStyle}>{block.title}</strong>}{block.text}</aside>;
    case "list": return <div style={proseStyle}>{block.title && <strong style={titleStyle}>{block.title}</strong>}<ul style={{ paddingLeft: 22, listStyleType: "disc" }}>{block.items.map((item, i) => <li key={i}>{item}</li>)}</ul></div>;
    case "keyValue": return <div style={proseStyle}>{block.title && <strong style={titleStyle}>{block.title}</strong>}<dl className="detail-list">{block.entries.map((entry, i) => <div className="detail-row" key={i} style={{ gap: 16, alignItems: "flex-start" }}><dt style={{ flex: 1 }}>{entry.key}</dt><dd style={{ flex: 1, margin: 0, overflowWrap: "anywhere" }}>{entry.value}</dd></div>)}</dl></div>;
    case "aspectTable": return <div style={{ overflowX: "auto", marginBottom: 20 }}><table style={{ width: "100%", tableLayout: "fixed", borderCollapse: "collapse", fontSize: 13 }}>
      <caption style={{ ...titleStyle, display: "table-caption", captionSide: "top", textAlign: "left" }}>{block.title ?? (locale === "es" ? "Aspectos" : "Aspects")}</caption>
      <thead><tr>{aspectHeadings(locale).map(heading => <th key={heading} scope="col" style={cellStyle}>{heading}</th>)}</tr></thead>
      <tbody>{block.rows.map((row, i) => <tr key={i}>{[row.a, row.b, row.type, `${row.orb}°`].map((text, j) => <td key={j} style={cellStyle}>{text}</td>)}</tr>)}</tbody>
    </table></div>;
    default: return null;
  }
}

/** Accept only the minimal view, never the stored facts/failureReason/accounting object. */
export function ReadingSectionView({ section, locale }: { section: DisplaySection; locale: Locale }): ReactElement {
  const headingId = `reading-section-${section.key}`;
  return <section className="panel" data-section={section.key} data-status={section.status} aria-labelledby={headingId} style={{ overflowWrap: "anywhere" }}>
    <h3 id={headingId}>{section.title}</h3>
    {section.subtitle && <p className="small muted">{section.subtitle}</p>}
    {section.notices.map(code => <p className="notice" key={code}>{NOTICE_COPY[code][locale]}</p>)}
    {section.blocks.map((block, index) => <ReadingBlockView block={block} key={index} locale={locale} />)}
    {section.closingQuestion && <p className="reading-question" style={{ ...proseStyle, fontStyle: "italic", borderLeft: "3px solid #a54d31", paddingLeft: 16 }}>{section.closingQuestion}</p>}
  </section>;
}

export function LockedSectionCard({ locked, locale }: { locked: SectionPreview; locale: Locale }): ReactElement {
  return <section className="panel" data-locked={locked.key} data-availability={locked.availability}>
    <h4>{locked.title}</h4><p style={proseStyle}>{locked.teaser}</p>
    <p className="small" style={{ color: "#65564a" }}>{PREVIEW_COPY[locked.availability][locale]}</p>
  </section>;
}

export function ReadingContentView({ content }: { content: ReadingContent }): ReactElement {
  const locale = content.locale;
  const saved = content.kind === "saved-reading";
  return <article lang={locale} style={{ overflowWrap: "anywhere" }} aria-labelledby="reading-content-title" data-document-id={saved ? content.id : undefined} data-content-version={saved ? content.contentVersion : undefined} data-edition={content.kind}>
    <header className="panel"><h2 id="reading-content-title">{editionTitle(content)}</h2>
      {saved ? <p className="small muted">{localeName(locale)} · {savedDate(content.generatedAt)}<br />{content.contentVersion} · {content.chartVersion}</p> : <p>{AVAILABILITY_COPY.chart_only[locale]}</p>}
      {content.notices.map(code => <p className="notice" key={code}>{NOTICE_COPY[code][locale]}</p>)}
    </header>
    {content.sections.map(section => <ReadingSectionView key={section.key} section={section} locale={locale} />)}
    {saved && content.previews.length > 0 && <section aria-labelledby="reading-previews-title">
      <div className="panel"><h3 id="reading-previews-title">{PREVIEW_COPY.title[locale]}</h3><p>{PREVIEW_COPY.notice[locale]}</p></div>
      {content.previews.map(locked => <LockedSectionCard key={locked.key} locked={locked} locale={locale} />)}
      <p><a className="plain-link" href="/pricing">{locale === "es" ? "Ver las funciones actuales de los planes" : "View current plan features"}</a></p>
    </section>}
  </article>;
}
