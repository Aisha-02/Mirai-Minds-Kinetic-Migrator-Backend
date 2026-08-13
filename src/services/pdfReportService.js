import PDFDocument from "pdfkit";

const BRAND_BLUE = "#008fd3";
const HEADER_BG = "#0f1418";
const TEXT_DARK = "#1c2024";
const MUTED = "#5c6670";

const FINDING_ROWS = [
  { key: "missingRecords", label: "Missing records" },
  { key: "missingValues", label: "Missing values" },
  { key: "valueMismatches", label: "Value mismatches" },
  { key: "duplicateRecords", label: "Postload duplicates" },
  { key: "baselineDuplicates", label: "Baseline duplicates" },
  { key: "extraRecords", label: "Extra records" },
];

function countItems(summary, key) {
  const value = summary?.[key];
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Pull a short executive summary from the AI narrative.
 * Prefers an "Executive summary" markdown section when present.
 */
export function extractExecutiveSummary(aiReportText) {
  const text = String(aiReportText || "").trim();
  if (!text) return "No narrative report is available for this comparison.";

  const execMatch = text.match(
    /(?:^|\n)#{1,3}\s*executive summary\s*\n([\s\S]*?)(?=\n#{1,3}\s|\n*$)/i,
  );
  if (execMatch?.[1]?.trim()) {
    return execMatch[1].trim();
  }

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return text.slice(0, 600);
  return paragraphs.slice(0, 2).join("\n\n").slice(0, 1200);
}

function formatTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function drawSectionHeading(doc, title) {
  doc
    .moveDown(0.8)
    .fillColor(BRAND_BLUE)
    .font("Helvetica-Bold")
    .fontSize(13)
    .text(title, { underline: false });
  doc
    .moveTo(doc.page.margins.left, doc.y + 2)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
    .strokeColor(BRAND_BLUE)
    .lineWidth(1)
    .stroke();
  doc.moveDown(0.6).fillColor(TEXT_DARK).font("Helvetica").fontSize(10);
}

/**
 * Build a comparison PDF and return it as a Buffer.
 * On-demand generation — no PDF cache in this project.
 *
 * @param {{
 *   batchId: string,
 *   summaryJson?: Record<string, unknown> | null,
 *   aiReportText?: string | null,
 *   generatedAt?: string | Date | null,
 * }} input
 * @returns {Promise<Buffer>}
 */
export function buildComparisonReportPdf(input) {
  const {
    batchId,
    summaryJson = null,
    aiReportText = "",
    generatedAt = null,
  } = input;

  const executiveSummary = extractExecutiveSummary(aiReportText);
  const generatedLabel = formatTimestamp(generatedAt);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      bufferPages: true,
      margins: { top: 56, bottom: 56, left: 50, right: 50 },
      info: {
        Title: `Comparison Report ${batchId}`,
        Author: "Kinetic Migrator",
        Subject: "Preload vs postload validation report",
      },
    });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth =
      doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // Header band
    doc.save();
    doc.rect(0, 0, doc.page.width, 72).fill(HEADER_BG);
    doc
      .fillColor("#ffffff")
      .font("Helvetica-Bold")
      .fontSize(16)
      .text("Kinetic Migrator", 50, 22, { width: pageWidth });
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#90cdff")
      .text("Comparison Validation Report", 50, 44, { width: pageWidth });
    doc.restore();

    doc.moveDown(3.2);
    doc.fillColor(TEXT_DARK).font("Helvetica-Bold").fontSize(18);
    doc.text("Preload / Postload Comparison Report");

    doc
      .moveDown(0.4)
      .font("Helvetica")
      .fontSize(10)
      .fillColor(MUTED)
      .text(`Batch ID: ${batchId}`)
      .text(`Generated: ${generatedLabel}`);

    drawSectionHeading(doc, "Executive summary");
    doc
      .fillColor(TEXT_DARK)
      .font("Helvetica")
      .fontSize(10)
      .text(executiveSummary, {
        align: "left",
        lineGap: 2,
      });

    drawSectionHeading(doc, "Findings by category");

    const colLabel = doc.page.margins.left;
    const colCount = doc.page.margins.left + pageWidth - 70;
    const rowHeight = 22;
    let tableY = doc.y;

    // Table header
    doc.save();
    doc.rect(colLabel, tableY, pageWidth, rowHeight).fill("#e8f6fc");
    doc
      .fillColor(BRAND_BLUE)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Category", colLabel + 8, tableY + 6)
      .text("Count", colCount, tableY + 6, { width: 62, align: "right" });
    doc.restore();
    tableY += rowHeight;

    FINDING_ROWS.forEach((row, index) => {
      const count = countItems(summaryJson, row.key);
      if (index % 2 === 0) {
        doc.save();
        doc.rect(colLabel, tableY, pageWidth, rowHeight).fill("#f7f9fb");
        doc.restore();
      }
      doc
        .fillColor(TEXT_DARK)
        .font("Helvetica")
        .fontSize(10)
        .text(row.label, colLabel + 8, tableY + 6)
        .font("Helvetica-Bold")
        .text(String(count), colCount, tableY + 6, {
          width: 62,
          align: "right",
        });
      tableY += rowHeight;
    });

    doc.y = tableY + 8;

    drawSectionHeading(doc, "Full narrative report");
    const narrative = String(aiReportText || "").trim() || "No narrative text.";
    doc
      .fillColor(TEXT_DARK)
      .font("Helvetica")
      .fontSize(10)
      .text(narrative, {
        align: "left",
        lineGap: 2,
      });

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      const pageNumber = i - range.start + 1;
      const total = range.count;
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor(MUTED)
        .text(
          `Page ${pageNumber} of ${total}`,
          doc.page.margins.left,
          doc.page.height - 40,
          {
            width: pageWidth,
            align: "center",
            lineBreak: false,
          },
        );
    }

    doc.end();
  });
}
