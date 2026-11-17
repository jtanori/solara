import React from "react";
import type { DocumentProps, PageProps } from "@react-pdf/renderer";
import { localeName } from "@/lib/i18n";
import { READING_LIMITS, sectionText, type DisplaySection } from "@/readings/presentation";
import type { ReadingBlock } from "@/readings/types";
import { AVAILABILITY_COPY, NOTICE_COPY, PREVIEW_COPY, aspectHeadings, editionTitle } from "@/readings/presentation-copy";
import { chartDetails, chartDisclaimer, chartPlacements, returnDate, savedDate } from "@/readings/presentation-format";
import { PDF_FONT, pdfGlyphsSupported, pdfLines } from "@/readings/pdf-fonts";
import { PDF_FIXED_LAYOUT_LIMITS, ReadingPdfError, type ReadingPdfInput } from "@/readings/pdf-contract";

type PdfRenderer = Pick<typeof import("@react-pdf/renderer"), "Document" | "Page" | "Text" | "View" | "StyleSheet" | "Font">;
// Do not inherit lineHeight into dynamic footer Text: layout 5.2 resolves it
// twice and clips the page number. Body text sets its own explicit leading.
function styles(renderer: PdfRenderer) { return renderer.StyleSheet.create({
  page: { backgroundColor: "#FBF7F2", paddingTop: 76, paddingBottom: 64, paddingHorizontal: 48, color: "#373330", fontFamily: PDF_FONT, fontSize: 10 },
  header: { position: "absolute", top: 30, left: 48, right: 48, height: 27, borderBottomWidth: 1, borderBottomColor: "#DDCFC5", flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  brand: { fontSize: 18, color: "#9F3C20", fontWeight: 700 },
  footer: { position: "absolute", bottom: 24, left: 48, right: 48, height: 28, borderTopWidth: 1, borderTopColor: "#DDCFC5", paddingTop: 8, flexDirection: "row", justifyContent: "space-between", fontSize: 8 },
  title: { fontSize: 28, lineHeight: 1.3, fontWeight: 700, marginBottom: 18 },
  section: { fontSize: 21, lineHeight: 1.3, fontWeight: 700, marginBottom: 12 },
  heading: { fontSize: 11, fontWeight: 700, marginBottom: 7 },
  small: { fontSize: 9, color: "#65564a", marginBottom: 12 },
  paragraph: { fontSize: 10, lineHeight: 1.5, marginBottom: 13 },
  notice: { fontSize: 9, lineHeight: 1.5, padding: 12, backgroundColor: "#F4E9E1", marginBottom: 14 },
  question: { fontSize: 10, fontStyle: "italic", borderLeftWidth: 2, borderLeftColor: "#a54d31", paddingLeft: 12, marginTop: 8, marginBottom: 16 },
  keyRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#E4D9CF", paddingVertical: 7, gap: 12 },
  key: { width: "40%", fontWeight: 700 }, value: { width: "57%" },
  tableHead: { position: "absolute", top: 112, left: 48, right: 48, flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#A58C7D", fontSize: 9, fontWeight: 700, paddingBottom: 7 },
  tableTitle: { position: "absolute", top: 76, left: 48, right: 48, fontWeight: 700, fontSize: 10 },
  tableRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#E4D9CF", paddingVertical: 7 },
  tableCell: { width: "28%", paddingRight: 10, fontSize: 9, lineHeight: 1.5 },
  tableOrb: { width: "16%", fontSize: 9, lineHeight: 1.5 },
}); }

/** Separate PDF primitives; the selection/projection is shared with HTML. */
export function SolarReturnDocument({ chart, content, renderer, onPageCount }: ReadingPdfInput & { renderer: PdfRenderer; onPageCount?: (pages: number) => void }): React.ReactElement<DocumentProps> {
  const { Document, Page, Text, View } = renderer;
  const s = styles(renderer);
  const locale = content.locale; const es = locale === "es"; const saved = content.kind === "saved-reading";
  const title = editionTitle(content);
  const strings = [chart.name, chart.returnPlace, returnDate(chart, locale), title, chartDisclaimer(chart, locale),
    ...chartDetails(chart, locale).flatMap(entry => [entry.key, entry.value]),
    ...chartPlacements(chart, locale).flatMap(entry => [entry.label, entry.value, entry.detail]),
    ...content.sections.flatMap(sectionText), ...content.notices.map(code => NOTICE_COPY[code][locale]),
    ...content.sections.flatMap(section => section.notices.map(code => NOTICE_COPY[code][locale])),
    ...(saved ? [content.contentVersion, content.chartVersion, ...content.previews.flatMap(preview => [preview.title, preview.teaser, PREVIEW_COPY[preview.availability][locale]])] : []),
  ];
  if (!pdfGlyphsSupported(strings, renderer)) throw new ReadingPdfError("pdf_glyphs");
  const wrap = (value: string, width = 499, size = 10, bold = false) => pdfLines(value, width, size, renderer, bold).join("\n");
  const header = <View fixed style={s.header}><Text style={s.brand}>solara.</Text><Text style={{ fontSize: 8 }}>{es ? "TU REVOLUCIÓN SOLAR" : "YOUR SOLAR RETURN"}</Text></View>;
  const footer = <View fixed style={s.footer}><Text>Solara · {chart.year} · {localeName(locale)}</Text><Text style={{ width: 80, textAlign: "right", fontSize: 8 }} render={({ pageNumber, totalPages }) => {
    if (totalPages) {
      if (totalPages > (saved && content.tier === "paid" ? READING_LIMITS.paidPdfPages : READING_LIMITS.pdfPages)) throw new ReadingPdfError("pdf_page_limit");
      onPageCount?.(totalPages);
    }
    return `${pageNumber} / ${totalPages}`;
  }} /></View>;
  const pages: React.ReactElement<PageProps>[] = [];
  const flowPage = (key: string, children: React.ReactNode[]) => {
    if (children.length) pages.push(<Page key={key} size="A4" style={s.page}>{header}{children}{footer}</Page>);
  };
  const paragraph = (text: string, key: string) => <Text key={key} style={s.paragraph} orphans={2} widows={2}>{wrap(text)}</Text>;
  const blockView = (block: Exclude<ReadingBlock, { kind: "aspectTable" }>, key: string): React.ReactNode => {
    const heading = "title" in block && block.title ? <Text style={s.heading} minPresenceAhead={24}>{wrap(block.title, 499, 11, true)}</Text> : null;
    switch (block.kind) {
      case "prose": return paragraph(block.text, key);
      case "callout": return <View key={key} style={s.notice}>{heading}<Text orphans={2} widows={2}>{wrap(block.text, 475, 9)}</Text></View>;
      case "list": return <View key={key}>{heading}{block.items.map((item, i) => <Text key={i} style={s.paragraph} orphans={2} widows={2}>{wrap(`• ${item}`)}</Text>)}</View>;
      case "keyValue": return <View key={key} style={{ marginBottom: 14 }}>{heading}{block.entries.map((entry, i) => <View key={i} style={s.keyRow}><Text style={s.key} orphans={2} widows={2}>{wrap(entry.key, 192, 10, true)}</Text><Text style={s.value} orphans={2} widows={2}>{wrap(entry.value, 275)}</Text></View>)}</View>;
      default: return null;
    }
  };
  const table = (block: Extract<ReadingBlock, { kind: "aspectTable" }>, key: string, leadingSection?: DisplaySection) => {
    // Small tables stay with surrounding prose. Larger tables get dedicated
    // wrapping pages with fixed headers. Long rows split at measured lines.
    let height = 0;
    const rows = block.rows.flatMap((row, index) => {
      const cells = [row.a, row.b, row.type, `${row.orb}°`].map((value, i) => pdfLines(value, i === 3 ? 69 : 129, 9, renderer));
      const count = Math.max(...cells.map(cell => cell.length));
      height += count * 14 + Math.ceil(count / 20) * 15;
      return Array.from({ length: Math.ceil(count / 20) }, (_, fragment) => <View key={`${index}-${fragment}`} style={s.tableRow} wrap={false}>
        {cells.map((lines, i) => <Text key={i} style={i === 3 ? s.tableOrb : s.tableCell}>{lines.slice(fragment * 20, (fragment + 1) * 20).join("\n")}</Text>)}
      </View>);
    });
    const titleLines = pdfLines(block.title ?? (es ? "Aspectos" : "Aspects"), 499, 10, renderer, true);
    const columns = aspectHeadings(locale).map((heading, i) => <Text key={i} style={{ width: i === 3 ? "16%" : "28%" }}>{heading}</Text>);
    const inline = height + titleLines.length * 15 < 280;
    // If a section starts with a long table, its heading must travel with the
    // rows, not create a heading-only page before the dedicated table pages.
    const repeatedTitle = leadingSection ? pdfLines([
      leadingSection.title, leadingSection.subtitle,
      ...leadingSection.notices.map(code => NOTICE_COPY[code][locale]),
      block.title ?? (es ? "Aspectos" : "Aspects"),
    ].filter(Boolean).join("\n"), 499, 10, renderer, true) : titleLines;
    // A fixed title cannot consume the space needed by a bounded row fragment.
    // Fail before layout, not after pages of clipped text or a render timeout.
    if (!inline && repeatedTitle.length > PDF_FIXED_LAYOUT_LIMITS.tableTitleLines) throw new ReadingPdfError("pdf_input_limit");
    return { inline, node: inline
      ? <View key={key} wrap={false} style={{ marginBottom: 16 }}><Text style={s.heading}>{titleLines.join("\n")}</Text><View style={{ flexDirection: "row", fontSize: 9, fontWeight: 700 }}>{columns}</View>{rows}</View>
      : <Page key={key} size="A4" style={{ ...s.page, paddingTop: 76 + repeatedTitle.length * 15 + 35 }}>{header}
          <Text fixed style={s.tableTitle}>{repeatedTitle.join("\n")}</Text>
          <View fixed style={{ ...s.tableHead, top: 76 + repeatedTitle.length * 15 + 8 }}>{columns}</View>
          {rows}{footer}
        </Page> };

  };
  flowPage("cover", [
    <Text key="title" style={s.title}>{wrap(title, 499, 28, true)}</Text>,
    <Text key="name" style={s.section}>{wrap(chart.name, 499, 21, true)}</Text>,
    <Text key="date" style={s.small}>{chart.year} · {localeName(locale)}{"\n"}{wrap(returnDate(chart, locale), 499, 9)}{"\n"}{wrap(chart.returnPlace, 499, 9)}</Text>,
    saved ? <Text key="version" style={s.small}>{savedDate(content.generatedAt)}{"\n"}{wrap(`${content.contentVersion} · ${content.chartVersion}`, 499, 9)}</Text> : <Text key="edition" style={s.notice}>{AVAILABILITY_COPY.chart_only[locale]}</Text>,
    ...content.notices.map(code => <Text key={code} style={s.notice}>{NOTICE_COPY[code][locale]}</Text>),
    <Text key="chart-heading" style={s.heading} minPresenceAhead={30}>{es ? "Datos guardados de la carta" : "Saved chart summary"}</Text>,
    ...chartPlacements(chart, locale).map(entry => <View key={entry.label} style={s.keyRow}><Text style={s.key}>{entry.label}</Text><Text style={s.value}>{entry.value} · {entry.detail}</Text></View>),
    ...chartDetails(chart, locale).map(entry => <View key={entry.key} style={s.keyRow}><Text style={s.key}>{entry.key}</Text><Text style={s.value}>{wrap(entry.value, 275)}</Text></View>),
    <Text key="disclaimer" style={{ ...s.small, marginTop: 18 }}>{wrap(chartDisclaimer(chart, locale), 499, 9)}</Text>,
  ]);
  let narrative: React.ReactNode[] = [];
  const renderSection = (section: DisplaySection) => {
    const beforeHeading = narrative.length;
    const titleLines = pdfLines(section.title, 499, 21, renderer, true);
    const subtitleLines = section.subtitle ? pdfLines(section.subtitle, 499, 9, renderer) : [];
    // Conservatively include leading, margins and notice padding. A 200-character
    // heading can contain 100 newlines: a character cap is not a height cap.
    const headingHeight = 28 + titleLines.length * 21 * 1.3 + (subtitleLines.length ? subtitleLines.length * 14 + 12 : 0) +
      section.notices.reduce((height, code) => height + pdfLines(NOTICE_COPY[code][locale], 475, 9, renderer).length * 14 + 38, 0);
    if (headingHeight > PDF_FIXED_LAYOUT_LIMITS.sectionHeadingPt) throw new ReadingPdfError("pdf_input_limit");
    // Only this geometrically bounded title/subtitle/notice group is unbreakable.
    // Reserve opening body lines too: a title with only its subtitle can still
    // be orphaned. The section body itself remains wrappable.
    narrative.push(<View key={`${section.key}-heading`} wrap={false} minPresenceAhead={section.blocks[0]?.kind === "aspectTable" ? 300 : 90}>
      <Text style={{ ...s.section, marginTop: 16 }}>{titleLines.join("\n")}</Text>
      {section.subtitle && <Text style={s.small}>{subtitleLines.join("\n")}</Text>}
      {section.notices.map(code => <Text key={code} style={s.notice}>{NOTICE_COPY[code][locale]}</Text>)}
    </View>);
    section.blocks.forEach((block, index) => {
      if (block.kind === "aspectTable") {
        const layout = table(block, `${section.key}-${index}-table`, index === 0 ? section : undefined);
        if (layout.inline) narrative.push(layout.node);
        else {
          if (index === 0) narrative.splice(beforeHeading);
          flowPage(`${section.key}-${index}-before`, narrative); narrative = [];
          pages.push(layout.node);
        }
      } else narrative.push(blockView(block, `${section.key}-${index}`));
    });
    if (section.closingQuestion) narrative.push(<Text key={`${section.key}-question`} style={s.question} orphans={2} widows={2}>{wrap(section.closingQuestion, 480)}</Text>);
  };
  content.sections.forEach(renderSection);
  flowPage("narrative-end", narrative);
  if (saved && content.previews.length) flowPage("previews", [
    <Text key="title" style={s.section} minPresenceAhead={50}>{PREVIEW_COPY.title[locale]}</Text>,
    <Text key="notice" style={s.notice}>{PREVIEW_COPY.notice[locale]}</Text>,
    ...content.previews.map(preview => <View key={preview.key} wrap={false} style={{ marginBottom: 18 }}>
      <Text style={s.heading} minPresenceAhead={35}>{preview.title}</Text><Text style={s.paragraph}>{wrap(preview.teaser)}</Text>
      <Text style={s.small}>{PREVIEW_COPY[preview.availability][locale]}</Text>
    </View>),
  ]);
  const timestamp = saved ? new Date(content.generatedAt) : new Date(chart.result.exactUtc);
  return <Document title={`${title} ${chart.year} | Solara`} author="Solara" subject={title} language={locale} creationDate={timestamp} modificationDate={timestamp}>{pages}</Document>;
}
