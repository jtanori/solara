import React from "react";
import type { DocumentProps, PageProps } from "@react-pdf/renderer";
import { localeName } from "@/lib/i18n";
import { READING_LIMITS, blockText, sectionText, type DisplaySection, type ReadingChart, type ReadingContent } from "@/readings/presentation";
import type { ReadingBlock } from "@/readings/types";
import { AVAILABILITY_COPY, NOTICE_COPY, PREVIEW_COPY, aspectHeadings, editionTitle } from "@/readings/presentation-copy";
import { chartDetails, chartDisclaimer, chartPlacements, returnDate, savedDate } from "@/readings/presentation-format";
import { PDF_FONT, pdfGlyphsSupported, pdfLines } from "@/readings/pdf-fonts";
import { projectWheel, type WheelGeometry } from "@/lib/wheel";
import { wheelAbsentText, wheelAccessibleName, wheelDrawingText, wheelOmissionText } from "@/readings/wheel-labels";
import { PdfChartWheel } from "@/components/pdf-chart-wheel";
import { houseSystemLabel } from "@/readings/base-presentation";
import { PDF_FIXED_LAYOUT_LIMITS, ReadingPdfError, type ReadingPdfInput } from "@/readings/pdf-contract";

type PdfRenderer = Pick<typeof import("@react-pdf/renderer"), "Document" | "Page" | "Text" | "View" | "StyleSheet" | "Font" | "Svg" | "G" | "Circle" | "Line" | "Rect">;
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

/**
 * Every string the document submits to `pdfGlyphsSupported`.
 *
 * Exported so the glyph-set test can assert the wheel is *in* it without rendering, and so a
 * mutation that drops the wheel from the set fails an assertion rather than producing a PDF
 * of boxes. `geometry` is optional: a document built without facts has no wheel and no
 * wheel strings, which is the honest case, not a gap.
 */
export function pdfStrings({ chart, content, geometry }: {
  chart: ReadingChart; content: ReadingContent; geometry: WheelGeometry | null; renderer: unknown;
}): string[] {
  const locale = content.locale; const saved = content.kind === "saved-reading";
  return [
    chart.name, chart.returnPlace, returnDate(chart, locale), editionTitle(content), chartDisclaimer(chart, locale),
    ...chartDetails(chart, locale).flatMap(entry => [entry.key, entry.value]),
    ...chartPlacements(chart, locale).flatMap(entry => [entry.label, entry.value, entry.detail]),
    ...(chart.calculation ?? []).flatMap(blockText),
    ...content.sections.flatMap(sectionText), ...content.notices.map(code => NOTICE_COPY[code][locale]),
    ...content.sections.flatMap(section => section.notices.map(code => NOTICE_COPY[code][locale])),
    // The wheel's visible text: sign names, house numbers, placed labels. Omitted labels are
    // not drawn, so they are not submitted — checking a character the PDF never prints would
    // reject a perfectly renderable chart.
    ...(geometry ? wheelDrawingText(geometry) : []),
    // …and every word around the drawing, from the same object the layout renders.
    ...wheelStrings(wheelCopy({ chart, content, geometry })),
    ...(saved ? [content.contentVersion, content.chartVersion, ...content.previews.flatMap(preview => [preview.title, preview.teaser, PREVIEW_COPY[preview.availability][locale]])] : []),
  ];
}

/**
 * Every word the wheel contributes to this document, in one place.
 *
 * The glyph gate and the layout must not each decide what the wheel says. Before this
 * existed, `pdfStrings` submitted only `wheelDrawingText` — the sign names, house numbers
 * and placed labels — while the heading, the accessible name, the description, the table
 * pointer and the omission notices were built separately, after the gate had run. A copy
 * change could therefore introduce an unsupported glyph, pass the gate on `chart.name`, and
 * return a successful PDF of boxes. Building the copy once and deriving *both* the strings
 * and the nodes from it makes that unreachable: if a character cannot be drawn, nothing is
 * drawn.
 *
 * `heading` is included because it is wheel copy — it only appears when a wheel does.
 */
export type WheelCopy = {
  heading: string;
  title: string;
  caption: string;
  notices: string[];
  /** Present only for a chart with no wheel: why there isn't one. */
  absent: string | null;
};

export function wheelCopy({ chart, content, geometry }: {
  chart: ReadingChart; content: ReadingContent; geometry: WheelGeometry | null;
}): WheelCopy {
  const locale = content.locale;
  const heading = locale === "es" ? "Rueda factual" : "Factual wheel";
  if (!geometry) {
    // Same condition the page uses: only promise a table the document actually carries.
    const hasTable = (chart.calculation?.length ?? 0) > 0;
    return { heading, title: "", caption: "", notices: [], absent: wheelAbsentText(hasTable, locale) };
  }
  const { title, description, tableNote } = wheelAccessibleName(
    chart.name, houseSystemLabel(geometry.houseSystem, locale), locale,
  );
  return {
    heading,
    title,
    caption: `${description} ${tableNote}`,
    notices: wheelOmissionText(geometry.omissions, locale),
    absent: null,
  };
}

/** Every string the wheel contributes, for the glyph gate. Empty when there is no wheel. */
function wheelStrings(copy: WheelCopy): string[] {
  return copy.absent !== null
    ? [copy.heading, copy.absent]
    : [copy.heading, copy.title, copy.caption, ...copy.notices];
}

/** Separate PDF primitives; the selection/projection is shared with HTML. */
export function SolarReturnDocument({ chart, content, wheelFacts, renderer, onPageCount }: ReadingPdfInput & { renderer: PdfRenderer; onPageCount?: (pages: number) => void }): React.ReactElement<DocumentProps> {
  const { Document, Page, Text, View } = renderer;
  // One projection, two emitters: the page passed `projectWheel(sameFacts, content.locale)`
  // as well, so the drawing here cannot disagree with the drawing there. `null` means the
  // chart legitimately has no wheel (legacy facts, or no Ascendant at high latitude) and
  // the PDF states that in words rather than drawing a substitute.
  const geometry = projectWheel(wheelFacts ?? null, content.locale);
  const s = styles(renderer);
  const locale = content.locale; const es = locale === "es"; const saved = content.kind === "saved-reading";
  const title = editionTitle(content);
  // The complete set of strings this document may draw, extracted so a test can prove the
  // wheel's own text is in it (issue #155: an uncovered glyph must be `pdf_glyphs`, never a
  // PDF of boxes). `geometry` is passed because omitted labels are not drawn and must not
  // be submitted to the glyph check on a caller's behalf.
  const strings = pdfStrings({ chart, content, geometry, renderer });
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
  /**
   * The wheel block: one unbreakable unit of fixed height, so it can never straddle a page
   * boundary. When there is no geometry the block becomes a sentence — the same reason the
   * page gives — rather than a decorative wheel standing in for a chart. Both live in the
   * same place in the document, so "where is the wheel" has one answer.
   */
  const wheel = wheelCopy({ chart, content, geometry });
  const wheelBlock = geometry
    ? <View key="wheel" wrap={false} style={{ marginTop: 14, marginBottom: 16 }}>
        <Text style={s.heading} minPresenceAhead={30}>{wheel.heading}</Text>
        {/* The words come from `wheel`, the same object the glyph gate checks. */}
        <PdfChartWheel text={wheel} geometry={geometry} renderer={renderer} />
        {wheel.notices.map((text, index) => (
          <Text key={`omission-${index}`} style={s.small}>{wrap(text, 499, 9)}</Text>
        ))}
      </View>
    // No geometry means no drawing — but not silence. A reader holding a PDF with no wheel and
    // no sentence explaining why is the failure the plan's Missing data section names, and
    // suppressing the copy to protect frozen snapshots confused two different documents: every
    // existing snapshot is a chart that never had a wheel and takes this same path, unchanged.
    : <View key="wheel-absent" wrap={false} style={{ marginTop: 14, marginBottom: 16 }}>
        <Text style={s.heading} minPresenceAhead={30}>{wheel.heading}</Text>
        <Text style={s.small}>{wrap(wheel.absent ?? "", 499, 9)}</Text>
      </View>;

  flowPage("cover", [
    <Text key="title" style={s.title}>{wrap(title, 499, 28, true)}</Text>,
    <Text key="name" style={s.section}>{wrap(chart.name, 499, 21, true)}</Text>,
    <Text key="date" style={s.small}>{chart.year} · {localeName(locale)}{"\n"}{wrap(returnDate(chart, locale), 499, 9)}{"\n"}{wrap(chart.returnPlace, 499, 9)}</Text>,
    saved ? <Text key="version" style={s.small}>{savedDate(content.generatedAt)}{"\n"}{wrap(`${content.contentVersion} · ${content.chartVersion}`, 499, 9)}</Text> : <Text key="edition" style={s.notice}>{AVAILABILITY_COPY.chart_only[locale]}</Text>,
    ...content.notices.map(code => <Text key={code} style={s.notice}>{NOTICE_COPY[code][locale]}</Text>),
    <Text key="chart-heading" style={s.heading} minPresenceAhead={30}>{es ? "Datos guardados de la carta" : "Saved chart summary"}</Text>,
    ...chartPlacements(chart, locale).map(entry => <View key={entry.label} style={s.keyRow}><Text style={s.key}>{entry.label}</Text><Text style={s.value}>{entry.value} · {entry.detail}</Text></View>),
    ...chartDetails(chart, locale).map(entry => <View key={entry.key} style={s.keyRow}><Text style={s.key}>{entry.key}</Text><Text style={s.value}>{wrap(entry.value, 275)}</Text></View>),
    wheelBlock,
    <Text key="disclaimer" style={{ ...s.small, marginTop: 18 }}>{wrap(chartDisclaimer(chart, locale), 499, 9)}</Text>,
  ]);
  let calculation: React.ReactNode[] = [];
  (chart.calculation ?? []).forEach((block, index) => {
    if (block.kind === "aspectTable") {
      const layout = table(block, `calculation-table-${index}`);
      if (layout.inline) calculation.push(layout.node);
      else { flowPage(`calculation-${index}`, calculation); calculation = []; pages.push(layout.node); }
    } else calculation.push(blockView(block, `calculation-${index}`));
  });
  flowPage("calculation-end", calculation);
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
