import { readFile } from 'node:fs/promises';
import * as mupdf from 'mupdf';
const pdfBytes = await readFile('E:/pdf-review-workbench/storage/uploads/1779611303902-Sample1.pdf');
const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf');
const pdf = doc.asPDF();
if (!pdf) throw new Error('not pdf');
const page = pdf.loadPage(0);
const fontResources = page.getObject().get('Resources').get('Font');
fontResources.forEach((valueObj, keyName) => {
  const font = valueObj.isDictionary?.() ? valueObj : valueObj.resolve?.();
  const descriptorObject = font?.get('FontDescriptor');
  const descriptor = descriptorObject?.isDictionary?.() ? descriptorObject : descriptorObject?.resolve?.();
  const fontFileObject = descriptor?.get('FontFile2') ?? descriptor?.get('FontFile3') ?? descriptor?.get('FontFile');
  const payload = {
    key: String(keyName),
    baseFont: font?.get('BaseFont')?.asName?.() ?? null,
    objectString: fontFileObject?.toString?.() ?? null,
    isDict: fontFileObject?.isDictionary?.() ?? null,
    isStream: fontFileObject?.isStream?.() ?? null,
    js: null,
    keys: []
  };
  try { payload.js = fontFileObject?.asJS?.() ?? null; } catch (error) { payload.js = String(error); }
  try { if (fontFileObject?.isDictionary?.()) { fontFileObject.forEach((val, key) => { payload.keys.push(String(key)); }); } } catch (error) { payload.keys = [String(error)]; }
  console.log(JSON.stringify(payload, null, 2));
});
