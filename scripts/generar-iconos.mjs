/* Genera iconos PNG 192/512 sólidos en color corporativo (sin dependencias). */
import fs from "node:fs";
import zlib from "node:zlib";

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(tipo, datos) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(datos.length);
  const cuerpo = Buffer.concat([Buffer.from(tipo, "ascii"), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cuerpo));
  return Buffer.concat([len, cuerpo, crc]);
}

function png(tamano) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(tamano, 0);
  ihdr.writeUInt32BE(tamano, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const fila = Buffer.concat([Buffer.from([0]), Buffer.alloc(tamano * 3)]);
  for (let x = 0; x < tamano; x++) {
    fila[1 + x * 3] = 0x8b; fila[2 + x * 3] = 0x1e; fila[3 + x * 3] = 0x24;
  }
  const crudo = Buffer.concat(Array.from({ length: tamano }, () => fila));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(crudo)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

fs.mkdirSync("public/assets", { recursive: true });
for (const t of [192, 512]) fs.writeFileSync(`public/assets/icon-${t}.png`, png(t));
console.log("iconos PNG generados");
