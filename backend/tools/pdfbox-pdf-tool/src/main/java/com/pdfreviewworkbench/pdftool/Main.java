package com.pdfreviewworkbench.pdftool;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.io.RandomAccessReadBufferedFile;
import org.apache.pdfbox.multipdf.Splitter;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDDocumentCatalog;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDNumberTreeNode;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDMarkInfo;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDMarkedContentReference;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDParentTreeValue;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDStructureElement;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDStructureTreeRoot;
import org.apache.pdfbox.pdmodel.documentinterchange.markedcontent.PDPropertyList;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;
import org.apache.pdfbox.pdmodel.graphics.state.RenderingMode;
import org.apache.pdfbox.util.Matrix;

public final class Main {
    private Main() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length == 0) {
            usage();
        }

        String command = args[0].toLowerCase(Locale.ROOT);
        if ("split".equals(command)) {
            split(args);
            return;
        }
        if ("tag".equals(command)) {
            tag(args);
            return;
        }

        usage();
    }

    private static void split(String[] args) throws IOException {
        if (args.length != 5) {
            System.err.println("Usage: java -jar pdfbox-pdf-tool.jar split <inputPdf> <outputDir> <pagesPerChunk> <manifestPath>");
            System.exit(2);
        }

        Path inputPdf = Path.of(args[1]);
        Path outputDir = Path.of(args[2]);
        int pagesPerChunk = Integer.parseInt(args[3]);
        Path manifestPath = Path.of(args[4]);

        if (pagesPerChunk <= 0) {
            throw new IllegalArgumentException("pagesPerChunk must be greater than 0");
        }

        Files.createDirectories(outputDir);
        Files.createDirectories(manifestPath.getParent());

        List<Chunk> chunks = new ArrayList<>();
        try (PDDocument document = Loader.loadPDF(new RandomAccessReadBufferedFile(inputPdf.toFile()))) {
            int pageCount = document.getNumberOfPages();
            Splitter splitter = new Splitter();
            splitter.setSplitAtPage(pagesPerChunk);
            List<PDDocument> splitDocuments = splitter.split(document);

            int startPage = 1;
            for (int index = 0; index < splitDocuments.size(); index += 1) {
                PDDocument chunkDocument = splitDocuments.get(index);
                int chunkPageCount = chunkDocument.getNumberOfPages();
                int endPage = startPage + chunkPageCount - 1;
                String fileName = "chunk-" + String.format(Locale.ROOT, "%03d", index + 1) + ".pdf";
                Path outputPath = outputDir.resolve(fileName);
                try {
                    chunkDocument.save(outputPath.toFile());
                } finally {
                    chunkDocument.close();
                }
                chunks.add(new Chunk(index + 1, fileName, startPage, endPage, chunkPageCount, Files.size(outputPath)));
                startPage = endPage + 1;
            }

            Files.writeString(manifestPath, manifestJson(inputPdf, pageCount, pagesPerChunk, chunks));
        }
    }

    private static void tag(String[] args) throws IOException {
        if (args.length != 5) {
            System.err.println("Usage: java -jar pdfbox-pdf-tool.jar tag <inputPdf> <tagPlanTsv> <outputPdf> <reportPath>");
            System.exit(2);
        }

        Path inputPdf = Path.of(args[1]);
        Path tagPlanPath = Path.of(args[2]);
        Path outputPdf = Path.of(args[3]);
        Path reportPath = Path.of(args[4]);
        List<TagPlanRow> rows = readTagPlan(tagPlanPath);

        Files.createDirectories(outputPdf.getParent());
        Files.createDirectories(reportPath.getParent());

        int writtenTags = 0;
        try (PDDocument document = Loader.loadPDF(new RandomAccessReadBufferedFile(inputPdf.toFile()))) {
            PDDocumentCatalog catalog = document.getDocumentCatalog();
            PDMarkInfo markInfo = new PDMarkInfo();
            markInfo.setMarked(true);
            markInfo.setSuspect(false);
            catalog.setMarkInfo(markInfo);
            if (!rows.isEmpty() && rows.get(0).language != null && !rows.get(0).language.isBlank()) {
                catalog.setLanguage(rows.get(0).language);
            } else if (catalog.getLanguage() == null || catalog.getLanguage().isBlank()) {
                catalog.setLanguage("en");
            }

            PDStructureTreeRoot structureRoot = new PDStructureTreeRoot();
            catalog.setStructureTreeRoot(structureRoot);
            PDStructureElement documentElement = new PDStructureElement("Document", structureRoot);
            structureRoot.appendKid(documentElement);

            Map<Integer, COSArray> parentArraysByStructParent = new HashMap<>();
            int parentTreeKey = 0;
            int globalMcid = 0;

            for (int pageIndex = 0; pageIndex < document.getNumberOfPages(); pageIndex += 1) {
                PDPage page = document.getPage(pageIndex);
                page.setStructParents(parentTreeKey);
                parentArraysByStructParent.put(parentTreeKey, new COSArray());

                final int currentPageIndex = pageIndex;
                List<TagPlanRow> pageRows = rows.stream()
                    .filter((row) -> row.pageIndex == currentPageIndex)
                    .sorted(Comparator.comparingInt((TagPlanRow row) -> row.readingOrder))
                    .toList();
                if (!pageRows.isEmpty()) {
                    try (PDPageContentStream contentStream = new PDPageContentStream(document, page, PDPageContentStream.AppendMode.APPEND, true, true)) {
                        for (TagPlanRow row : pageRows) {
                            if ("Artifact".equals(row.tag)) {
                                continue;
                            }
                            String structureType = normalizeStructureType(row.tag);
                            String readableText = readableText(row);
                            if (readableText.isBlank() && !"Figure".equals(structureType)) {
                                continue;
                            }

                            int mcid = globalMcid;
                            globalMcid += 1;
                            PDStructureElement element = new PDStructureElement(structureType, documentElement);
                            element.setPage(page);
                            if (row.language != null && !row.language.isBlank()) {
                                element.setLanguage(row.language);
                            }
                            if (!readableText.isBlank()) {
                                element.setActualText(readableText);
                            }
                            if ("Figure".equals(structureType)) {
                                element.setAlternateDescription(row.altText == null || row.altText.isBlank() ? readableText : row.altText);
                            }

                            PDMarkedContentReference reference = new PDMarkedContentReference();
                            reference.setPage(page);
                            reference.setMCID(mcid);
                            element.appendKid(reference);
                            documentElement.appendKid(element);
                            parentArraysByStructParent.get(parentTreeKey).add(element.getCOSObject());

                            appendInvisibleMarkedText(contentStream, page, row, structureType, mcid, readableText);
                            writtenTags += 1;
                        }
                    }
                }
                parentTreeKey += 1;
            }

            PDNumberTreeNode parentTree = new PDNumberTreeNode(PDParentTreeValue.class);
            Map<Integer, PDParentTreeValue> numbers = new HashMap<>();
            for (Map.Entry<Integer, COSArray> entry : parentArraysByStructParent.entrySet()) {
                numbers.put(entry.getKey(), new PDParentTreeValue(entry.getValue()));
            }
            parentTree.setNumbers(numbers);
            structureRoot.setParentTree(parentTree);
            structureRoot.setParentTreeNextKey(parentTreeKey);

            document.save(outputPdf.toFile());
            Files.writeString(reportPath, tagReportJson(inputPdf, outputPdf, rows.size(), writtenTags, document.getNumberOfPages()));
        }
    }

    private static void appendInvisibleMarkedText(
        PDPageContentStream contentStream,
        PDPage page,
        TagPlanRow row,
        String structureType,
        int mcid,
        String readableText
    ) throws IOException {
        COSDictionary properties = new COSDictionary();
        properties.setInt(COSName.MCID, mcid);
        PDPropertyList propertyList = PDPropertyList.create(properties);
        contentStream.beginMarkedContent(COSName.getPDFName(structureType), propertyList);
        if (!readableText.isBlank()) {
            PDRectangle cropBox = page.getCropBox();
            float x = cropBox.getLowerLeftX() + (float) ((row.x / Math.max(1.0, row.pageWidth)) * cropBox.getWidth());
            float yFromTop = (float) (((row.y + Math.min(row.h, 12.0)) / Math.max(1.0, row.pageHeight)) * cropBox.getHeight());
            float y = cropBox.getUpperRightY() - yFromTop;
            contentStream.beginText();
            contentStream.setFont(new PDType1Font(Standard14Fonts.FontName.HELVETICA), 1.0f);
            contentStream.setRenderingMode(RenderingMode.NEITHER);
            contentStream.setTextMatrix(Matrix.getTranslateInstance(x, y));
            contentStream.showText(toWinAnsiSafe(readableText));
            contentStream.endText();
            contentStream.setRenderingMode(RenderingMode.FILL);
        }
        contentStream.endMarkedContent();
    }

    private static String normalizeStructureType(String tag) {
        return switch (tag) {
            case "H1", "H2", "H3", "H4", "H5", "H6", "P", "L", "LI", "Table", "TR", "TH", "TD", "Figure", "Caption", "Formula" -> tag;
            default -> "P";
        };
    }

    private static String readableText(TagPlanRow row) {
        if ("Figure".equals(row.tag)) {
            return firstNonBlank(row.altText, row.actualText, row.text);
        }
        if ("Formula".equals(row.tag)) {
            return firstNonBlank(row.actualText, row.formulaLatex, row.text);
        }
        return firstNonBlank(row.actualText, row.text, row.altText);
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return "";
    }

    private static String toWinAnsiSafe(String value) {
        StringBuilder builder = new StringBuilder();
        for (int offset = 0; offset < value.length();) {
            int codePoint = value.codePointAt(offset);
            builder.append(codePoint >= 32 && codePoint <= 255 ? (char) codePoint : ' ');
            offset += Character.charCount(codePoint);
        }
        return builder.toString().replaceAll("\\s+", " ").trim();
    }

    private static List<TagPlanRow> readTagPlan(Path tagPlanPath) throws IOException {
        List<TagPlanRow> rows = new ArrayList<>();
        List<String> lines = Files.readAllLines(tagPlanPath);
        for (int index = 1; index < lines.size(); index += 1) {
            String line = lines.get(index);
            if (line.isBlank()) {
                continue;
            }
            String[] parts = line.split("\t", -1);
            if (parts.length < 16) {
                throw new IOException("Invalid tag plan row " + (index + 1) + ": expected 16 fields, got " + parts.length);
            }
            rows.add(new TagPlanRow(
                Integer.parseInt(parts[0]),
                Integer.parseInt(parts[1]),
                parts[2],
                Double.parseDouble(parts[3]),
                Double.parseDouble(parts[4]),
                Double.parseDouble(parts[5]),
                Double.parseDouble(parts[6]),
                Double.parseDouble(parts[7]),
                Double.parseDouble(parts[8]),
                decode(parts[9]),
                decode(parts[10]),
                decode(parts[11]),
                decode(parts[12]),
                decode(parts[13]),
                decode(parts[14]),
                decode(parts[15])
            ));
        }
        return rows;
    }

    private static String decode(String value) {
        if (value == null || value.isBlank()) {
            return "";
        }
        return new String(Base64.getDecoder().decode(value), java.nio.charset.StandardCharsets.UTF_8);
    }

    private static String manifestJson(Path inputPdf, int pageCount, int pagesPerChunk, List<Chunk> chunks) {
        StringBuilder builder = new StringBuilder();
        builder.append("{\n");
        builder.append("  \"engine\": \"pdfbox\",\n");
        builder.append("  \"sourcePdf\": ").append(json(inputPdf.toAbsolutePath().toString())).append(",\n");
        builder.append("  \"pageCount\": ").append(pageCount).append(",\n");
        builder.append("  \"pagesPerChunk\": ").append(pagesPerChunk).append(",\n");
        builder.append("  \"chunks\": [\n");
        for (int index = 0; index < chunks.size(); index += 1) {
            Chunk chunk = chunks.get(index);
            builder.append("    {\n");
            builder.append("      \"chunkIndex\": ").append(chunk.chunkIndex).append(",\n");
            builder.append("      \"fileName\": ").append(json(chunk.fileName)).append(",\n");
            builder.append("      \"startPage\": ").append(chunk.startPage).append(",\n");
            builder.append("      \"endPage\": ").append(chunk.endPage).append(",\n");
            builder.append("      \"pageCount\": ").append(chunk.pageCount).append(",\n");
            builder.append("      \"sizeBytes\": ").append(chunk.sizeBytes).append("\n");
            builder.append("    }");
            if (index < chunks.size() - 1) {
                builder.append(",");
            }
            builder.append("\n");
        }
        builder.append("  ]\n");
        builder.append("}\n");
        return builder.toString();
    }

    private static String json(String value) {
        return "\"" + value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r") + "\"";
    }

    private static void usage() {
        System.err.println("Usage:");
        System.err.println("  java -jar pdfbox-pdf-tool.jar split <inputPdf> <outputDir> <pagesPerChunk> <manifestPath>");
        System.err.println("  java -jar pdfbox-pdf-tool.jar tag <inputPdf> <tagPlanTsv> <outputPdf> <reportPath>");
        System.exit(2);
    }

    private record Chunk(int chunkIndex, String fileName, int startPage, int endPage, int pageCount, long sizeBytes) {
    }

    private record TagPlanRow(
        int pageIndex,
        int readingOrder,
        String tag,
        double x,
        double y,
        double w,
        double h,
        double pageWidth,
        double pageHeight,
        String text,
        String actualText,
        String altText,
        String language,
        String formulaLatex,
        String formulaMathml,
        String status
    ) {
    }

    private static String tagReportJson(Path inputPdf, Path outputPdf, int plannedTags, int writtenTags, int pageCount) {
        return "{\n"
            + "  \"engine\": \"pdfbox\",\n"
            + "  \"sourcePdf\": " + json(inputPdf.toAbsolutePath().toString()) + ",\n"
            + "  \"outputPdf\": " + json(outputPdf.toAbsolutePath().toString()) + ",\n"
            + "  \"pageCount\": " + pageCount + ",\n"
            + "  \"plannedTags\": " + plannedTags + ",\n"
            + "  \"writtenTags\": " + writtenTags + "\n"
            + "}\n";
    }
}
