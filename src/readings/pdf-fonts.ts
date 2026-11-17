import { join } from "node:path";

export const PDF_FONT = "Solara Noto Sans";
type Renderer = Pick<typeof import("@react-pdf/renderer"), "Font">;
/** One registration per isolated process, before React-PDF resolves any layout. */
export async function loadPdfFonts(renderer: Renderer, directory: string) {
  if (!renderer.Font.getRegisteredFontFamilies().includes(PDF_FONT)) {
    renderer.Font.register({ family: PDF_FONT, fonts: [
      { src: join(directory, "noto-sans-latin-400-normal.woff"), fontWeight: 400 },
      { src: join(directory, "noto-sans-latin-700-normal.woff"), fontWeight: 700 },
      { src: join(directory, "noto-sans-latin-400-italic.woff"), fontStyle: "italic" },
    ] });
    renderer.Font.registerHyphenationCallback(word => [word]);
  }
  await Promise.all([
    renderer.Font.load({ fontFamily: PDF_FONT, fontWeight: 400 }),
    renderer.Font.load({ fontFamily: PDF_FONT, fontWeight: 700 }),
    renderer.Font.load({ fontFamily: PDF_FONT, fontStyle: "italic" }),
  ]);
}

function pdfFont(renderer: Renderer, bold = false, italic = false) {
  const font = renderer.Font.getFont({ fontFamily: PDF_FONT, fontWeight: bold ? 700 : 400, fontStyle: italic ? "italic" : "normal" }).data;
  if (!font) throw new Error("pdf_fonts_not_loaded");
  return font;
}

/** Reject unsupported glyphs, rather than returning a successful PDF of boxes. */
export function pdfGlyphsSupported(strings: string[], renderer: Renderer): boolean {
  const fonts = [pdfFont(renderer), pdfFont(renderer, true), pdfFont(renderer, false, true)];
  return strings.every(text => [...text].every(character => {
    if ("\n\r\t".includes(character)) return true;
    const point = character.codePointAt(0)!;
    return point >= 32 && point !== 127 && fonts.every(font => font.hasGlyphForCodePoint(point));
  }));
}

/** Measured, lossless line breaks. No hyphens/ellipsis, including unbroken words.
 * The line strings concatenate to the input (apart from existing newlines).
 * A small width reserve covers the renderer's kerning and space handling.
 */
export function pdfLines(text: string, width: number, size: number, renderer: Renderer, bold = false): string[] {
  const font = pdfFont(renderer, bold);
  const advance = new Map<string, number>();
  const measure = (character: string) => {
    let value = advance.get(character);
    if (value === undefined) {
      value = font.layout(character).glyphs.reduce((sum: number, glyph: { advanceWidth: number }) => sum + glyph.advanceWidth, 0) * size / font.unitsPerEm;
      advance.set(character, value);
    }
    return value;
  };
  const output: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n")) {
    let line = ""; let used = 0;
    for (const token of paragraph.match(/\s+|\S+/gu) ?? []) {
      const tokenWidth = [...token].reduce((sum, character) => sum + measure(character), 0);
      if (line && used + tokenWidth > width * 0.94) { output.push(line); line = ""; used = 0; }
      for (const character of token) {
        const next = measure(character);
        if (line && used + next > width * 0.94) { output.push(line); line = ""; used = 0; }
        line += character; used += next;
      }
    }
    output.push(line);
  }
  return output;
}
