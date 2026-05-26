import { readFile } from 'node:fs/promises';
import * as mupdf from 'mupdf';

const pdfBytes = await readFile('E:/pdf-review-workbench/storage/uploads/1779611303902-Sample1.pdf');
const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf');
const pdf = doc.asPDF();
if (!pdf) throw new Error('not pdf');
const page = pdf.loadPage(0);
const pageObj = page.getObject();
const resources = pageObj.get('Resources');
const fontResources = resources.get('Font');
const rows = [];
fontResources.forEach((valueObj, keyName) => {
  const font = valueObj.resolve();
  const baseFont = font.get('BaseFont')?.asName?.();
  const descriptor = font.get('FontDescriptor')?.resolve?.();
  const fontFileObject = descriptor?.get('FontFile2') || descriptor?.get('FontFile3') || descriptor?.get('FontFile');
  const stream = fontFileObject?.resolve?.();
  let rawLength = null;
  let decodedLength = null;
  let subtype = null;
  if (stream?.isStream?.()) {
    subtype = stream.get('Subtype')?.asName?.() ?? null;
    try {
      const raw = stream.readRawStream();
      rawLength = raw?.length ?? null;
    } catch (error) {
      rawLength = String(error);
    }
    try {
      const decoded = stream.readStream();
      decodedLength = decoded?.length ?? null;
    } catch (error) {
      decodedLength = String(error);
    }
  }
  rows.push({ key: String(keyName), baseFont, subtype, rawLength, decodedLength });
});
console.log(JSON.stringify(rows, null, 2));
