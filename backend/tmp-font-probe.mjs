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
  const subtype = font.get('Subtype')?.asName?.();
  const baseFont = font.get('BaseFont')?.asName?.();
  const descriptor = font.get('FontDescriptor')?.resolve?.();
  const descendants = font.get('DescendantFonts');
  let descendantSubtype = '';
  let descendantBaseFont = '';
  let descendantHasDescriptor = false;
  let descendantHasFontFile = false;
  if (descendants && descendants.length > 0) {
    const descendant = descendants.get(0)?.resolve?.();
    descendantSubtype = descendant?.get('Subtype')?.asName?.() ?? '';
    descendantBaseFont = descendant?.get('BaseFont')?.asName?.() ?? '';
    const descendantDescriptor = descendant?.get('FontDescriptor')?.resolve?.();
    descendantHasDescriptor = !!descendantDescriptor?.isDictionary?.();
    descendantHasFontFile = !!(descendantDescriptor?.get('FontFile') || descendantDescriptor?.get('FontFile2') || descendantDescriptor?.get('FontFile3'));
  }
  rows.push({
    key: String(keyName),
    subtype,
    baseFont,
    hasDescriptor: !!descriptor?.isDictionary?.(),
    hasFontFile: !!(descriptor?.get('FontFile') || descriptor?.get('FontFile2') || descriptor?.get('FontFile3')),
    descendantSubtype,
    descendantBaseFont,
    descendantHasDescriptor,
    descendantHasFontFile
  });
});
console.log(JSON.stringify(rows, null, 2));
