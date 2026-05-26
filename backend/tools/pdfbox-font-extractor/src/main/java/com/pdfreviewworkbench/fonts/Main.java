package com.pdfreviewworkbench.fonts;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSStream;
import org.apache.pdfbox.io.RandomAccessReadBufferedFile;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.common.PDStream;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDFontDescriptor;
import org.apache.pdfbox.pdmodel.font.PDType0Font;

public final class Main {
    private Main() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 3) {
            System.err.println("Usage: java -jar pdfbox-font-extractor.jar <inputPdf> <outputFontsDir> <outputManifestPath>");
            System.exit(2);
        }

        Path inputPdf = Path.of(args[0]);
        Path outputFontsDir = Path.of(args[1]);
        Path outputManifest = Path.of(args[2]);

        Files.createDirectories(outputFontsDir);
        Files.createDirectories(outputManifest.getParent());

        Manifest manifest = extractFonts(inputPdf, outputFontsDir);
        manifest.sourcePdf = inputPdf.toAbsolutePath().toString();
        Files.writeString(outputManifest, manifest.toJson());
    }

    private static Manifest extractFonts(Path inputPdf, Path outputFontsDir) throws IOException, NoSuchAlgorithmException {
        Manifest manifest = new Manifest();
        Map<String, FontEntry> byFingerprint = new LinkedHashMap<>();

        try (PDDocument document = Loader.loadPDF(new RandomAccessReadBufferedFile(inputPdf.toFile()))) {
            int pageNumber = 0;
            for (PDPage page : document.getPages()) {
                pageNumber += 1;
                PDResources resources = page.getResources();
                if (resources == null) {
                    continue;
                }

                for (COSName resourceName : resources.getFontNames()) {
                    PDFont font;
                    try {
                        font = resources.getFont(resourceName);
                    } catch (IOException ex) {
                        continue;
                    }
                    if (font == null) {
                        continue;
                    }

                    PDFontDescriptor descriptor = font.getFontDescriptor();
                    if (descriptor == null && font instanceof PDType0Font type0Font) {
                        descriptor = type0Font.getDescendantFont().getFontDescriptor();
                    }
                    if (descriptor == null) {
                        continue;
                    }

                    StreamDetails streamDetails = resolveStream(descriptor);
                    if (streamDetails == null) {
                        continue;
                    }

                    byte[] bytes;
                    try (InputStream input = streamDetails.stream.createInputStream()) {
                        bytes = input.readAllBytes();
                    }
                    if (bytes.length == 0) {
                        continue;
                    }

                    String baseFont = safeFontName(font, resourceName);
                    String family = normalizeFamily(baseFont);
                    String fontWeight = looksBold(baseFont) ? "bold" : "normal";
                    String fontStyle = looksItalic(baseFont) ? "italic" : "normal";
                    String format = detectFormat(streamDetails.type, streamDetails.stream);
                    String extension = extensionFor(format);
                    String hash = sha256(bytes).substring(0, 8);
                    String dedupeKey = family.toLowerCase(Locale.ROOT) + "|" + format + "|" + hash;

                    FontEntry existing = byFingerprint.get(dedupeKey);
                    if (existing == null) {
                        String fileName = slugify(family) + "-" + hash + "." + extension;
                        Files.write(outputFontsDir.resolve(fileName), bytes);

                        FontEntry entry = new FontEntry();
                        entry.resourceName = resourceName.getName();
                        entry.baseFont = baseFont;
                        entry.family = family;
                        entry.format = format;
                        entry.fileName = fileName;
                        entry.fontWeight = fontWeight;
                        entry.fontStyle = fontStyle;
                        entry.pages.add(pageNumber);
                        byFingerprint.put(dedupeKey, entry);
                    } else {
                        existing.pages.add(pageNumber);
                    }
                }
            }
        }

        manifest.fonts.addAll(byFingerprint.values().stream()
            .sorted(Comparator.comparing(entry -> entry.family.toLowerCase(Locale.ROOT)))
            .toList());
        return manifest;
    }

    private static StreamDetails resolveStream(PDFontDescriptor descriptor) {
        if (descriptor.getFontFile2() != null) {
            return new StreamDetails(descriptor.getFontFile2(), "fontfile2");
        }
        if (descriptor.getFontFile3() != null) {
            return new StreamDetails(descriptor.getFontFile3(), "fontfile3");
        }
        if (descriptor.getFontFile() != null) {
            return new StreamDetails(descriptor.getFontFile(), "fontfile");
        }
        return null;
    }

    private static String safeFontName(PDFont font, COSName resourceName) {
        String value = font.getName();
        if (value != null && !value.isBlank()) {
            return value;
        }
        String fallback = font.getCOSObject().getNameAsString(COSName.BASE_FONT);
        if (fallback != null && !fallback.isBlank()) {
            return fallback;
        }
        return resourceName.getName();
    }

    private static String normalizeFamily(String baseFont) {
        String withoutSubset = baseFont.replaceFirst("^[A-Z]{6}\\+", "");
        String normalized = withoutSubset
            .replace(',', ' ')
            .replace('-', ' ')
            .replace('_', ' ')
            .replaceAll("\\s+", " ")
            .trim();
        return normalized.isEmpty() ? "pdffont" : normalized;
    }

    private static boolean looksBold(String fontName) {
        String normalized = fontName.toLowerCase(Locale.ROOT);
        return normalized.contains("bold") || normalized.contains("black") || normalized.contains("heavy") || normalized.contains("demi");
    }

    private static boolean looksItalic(String fontName) {
        String normalized = fontName.toLowerCase(Locale.ROOT);
        return normalized.contains("italic") || normalized.contains("oblique");
    }

    private static String detectFormat(String type, PDStream stream) {
        if ("fontfile2".equals(type)) {
            return "truetype";
        }
        if ("fontfile".equals(type)) {
            return "type1";
        }

        COSStream cosStream = stream.getCOSObject();
        String subtype = cosStream.getNameAsString(COSName.SUBTYPE);
        if (subtype == null) {
            return "opentype";
        }

        String normalized = subtype.toLowerCase(Locale.ROOT);
        if (normalized.contains("open")) {
            return "opentype";
        }
        if (normalized.contains("truetype")) {
            return "truetype";
        }
        if (normalized.contains("type1") || normalized.contains("cff")) {
            return "type1";
        }
        if (normalized.contains("woff2")) {
            return "woff2";
        }
        if (normalized.contains("woff")) {
            return "woff";
        }
        return "unknown";
    }

    private static String extensionFor(String format) {
        return switch (format) {
            case "truetype" -> "ttf";
            case "opentype", "type1", "unknown" -> "otf";
            case "woff" -> "woff";
            case "woff2" -> "woff2";
            default -> "bin";
        };
    }

    private static String slugify(String value) {
        String slug = value.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-").replaceAll("^-+|-+$", "");
        return slug.isEmpty() ? "pdffont" : slug;
    }

    private static String sha256(byte[] bytes) throws NoSuchAlgorithmException {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hashed = digest.digest(bytes);
        StringBuilder builder = new StringBuilder();
        for (byte b : hashed) {
            builder.append(String.format("%02x", b));
        }
        return builder.toString();
    }

    private static String escapeJson(String value) {
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            switch (ch) {
                case '\\' -> builder.append("\\\\");
                case '"' -> builder.append("\\\"");
                case '\b' -> builder.append("\\b");
                case '\f' -> builder.append("\\f");
                case '\n' -> builder.append("\\n");
                case '\r' -> builder.append("\\r");
                case '\t' -> builder.append("\\t");
                default -> {
                    if (ch < 0x20) {
                        builder.append(String.format("\\u%04x", (int) ch));
                    } else {
                        builder.append(ch);
                    }
                }
            }
        }
        return builder.toString();
    }

    private static final class StreamDetails {
        private final PDStream stream;
        private final String type;

        private StreamDetails(PDStream stream, String type) {
            this.stream = stream;
            this.type = type;
        }
    }

    private static final class FontEntry {
        private String resourceName;
        private String baseFont;
        private String family;
        private String format;
        private String fileName;
        private String fontWeight;
        private String fontStyle;
        private final Set<Integer> pages = new TreeSet<>();

        private String toJson() {
            StringBuilder builder = new StringBuilder();
            builder.append("      {\n");
            builder.append("        \"resourceName\": \"").append(escapeJson(resourceName)).append("\",\n");
            builder.append("        \"baseFont\": \"").append(escapeJson(baseFont)).append("\",\n");
            builder.append("        \"family\": \"").append(escapeJson(family)).append("\",\n");
            builder.append("        \"format\": \"").append(escapeJson(format)).append("\",\n");
            builder.append("        \"fileName\": \"").append(escapeJson(fileName)).append("\",\n");
            builder.append("        \"fontWeight\": \"").append(escapeJson(fontWeight)).append("\",\n");
            builder.append("        \"fontStyle\": \"").append(escapeJson(fontStyle)).append("\",\n");
            builder.append("        \"pages\": [");
            int index = 0;
            for (Integer page : pages) {
                if (index++ > 0) {
                    builder.append(", ");
                }
                builder.append(page);
            }
            builder.append("]\n");
            builder.append("      }");
            return builder.toString();
        }
    }

    private static final class Manifest {
        private String sourcePdf = "";
        private final List<FontEntry> fonts = new ArrayList<>();

        private String toJson() {
            StringBuilder builder = new StringBuilder();
            builder.append("{\n");
            builder.append("  \"sourcePdf\": \"").append(escapeJson(sourcePdf)).append("\",\n");
            builder.append("  \"engine\": \"pdfbox\",\n");
            builder.append("  \"status\": \"ok\",\n");
            builder.append("  \"fonts\": [\n");
            for (int index = 0; index < fonts.size(); index++) {
                if (index > 0) {
                    builder.append(",\n");
                }
                builder.append(fonts.get(index).toJson());
            }
            builder.append("\n  ]\n");
            builder.append("}\n");
            return builder.toString();
        }
    }
}
