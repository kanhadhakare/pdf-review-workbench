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
fontResources.forEach((valueObj, keyName) => {
  try {
    const fontA = valueObj.isDictionary?.() ? valueObj : valueObj.resolve?.();
    const descriptorObject = fontA?.get('FontDescriptor');
    const descriptor = descriptorObject?.isDictionary?.() ? descriptorObject : descriptorObject?.resolve?.();
    const fontFileObject = descriptor?.get('FontFile2') ?? descriptor?.get('FontFile3') ?? descriptor?.get('FontFile');
    const fontStream = fontFileObject?.isStream?.() ? fontFileObject : fontFileObject?.resolve?.();
    console.log(JSON.stringify({ key: String(keyName), ok: true, fontIsDict: !!fontA?.isDictionary?.(), descriptorIsDict: !!descriptor?.isDictionary?.(), fileIsStream: !!fontFileObject?.isStream?.(), resolvedStream: !!fontStream?.isStream?.() }));
  } catch (error) {
    console.log(JSON.stringify({ key: String(keyName), ok: false, message: error instanceof Error ? error.message : String(error) }));
  }
});
