import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

test('ExcelJS esporta e rilegge le regole estese che generano UUID v4', async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Compatibility');
  sheet.addRows([[1], [2], [3]]);
  sheet.addConditionalFormatting({ ref: 'A1:A3', rules: [{ type: 'iconSet', iconSet: '3Stars', cfvo: [{ type: 'percent', value: 0 }, { type: 'percent', value: 33 }, { type: 'percent', value: 67 }] }] });
  const buffer = await book.xlsx.writeBuffer();
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(xml, /x14:cfRule/);
  assert.match(xml, /id="\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}"/);
  const copy = new ExcelJS.Workbook(); await copy.xlsx.load(buffer);
  assert.equal(copy.getWorksheet('Compatibility').getCell('A3').value, 3);
  assert.equal(copy.getWorksheet('Compatibility').conditionalFormattings[0].rules[0].iconSet, '3Stars');
});
