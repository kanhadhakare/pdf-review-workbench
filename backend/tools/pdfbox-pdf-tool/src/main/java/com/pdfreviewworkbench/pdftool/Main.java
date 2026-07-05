package com.pdfreviewworkbench.pdftool;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.io.RandomAccessReadBufferedFile;
import org.apache.pdfbox.multipdf.Splitter;
import org.apache.pdfbox.pdmodel.PDDocument;

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
        System.exit(2);
    }

    private record Chunk(int chunkIndex, String fileName, int startPage, int endPage, int pageCount, long sizeBytes) {
    }
}
