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
  const font = valueObj.isDictionary?.() ? valueObj : valueObj.resolve?.();
  const descriptorObject = font?.get('FontDescriptor');
  const descriptor = descriptorObject?.isDictionary?.() ? descriptorObject : descriptorObject?.resolve?.();
  const fontFileObject = descriptor?.get('FontFile2') ?? descriptor?.get('FontFile3') ?? descriptor?.get('FontFile');
  let directRaw = null;
  let directDecoded = null;
  try { directRaw = fontFileObject?.readRawStream?.()?.length ?? null; } catch (error) { directRaw = String(error); }
  try { directDecoded = fontFileObject?.readStream?.()?.length ?? null; } catch (error) { directDecoded = String(error); }
  console.log(JSON.stringify({ key: String(keyName), fileIsStream: fontFileObject?.isStream?.() ?? null, directRaw, directDecoded }));
});
