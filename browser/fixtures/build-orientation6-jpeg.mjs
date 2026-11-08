/**
 * Builds `orientation6.jpg`: a real baseline JPEG whose stored frame is 40x20,
 * whose EXIF Orientation tag is 6 (rotate 90° clockwise for display), and whose
 * stored pixels carry two horizontal bands - the top 8 rows light, the rest
 * dark - so honouring the tag is visible as well as measurable: the upright
 * image is 20x40 with the light band on its right.
 *
 * The fixture is written by hand so it needs no image library and no browser.
 * The bands are encoded as DC-only 8x8 blocks (the light band is level 200, the
 * dark band level 100, so the first block of each band changes the DC predictor
 * and every other block repeats it), the AC coefficients are all zero, and the
 * two Huffman tables define exactly the symbols the entropy data uses. That
 * keeps the file a few hundred bytes while remaining an ordinary decodable JPEG.
 *
 * Run from the repository root:
 *
 *   node browser/fixtures/build-orientation6-jpeg.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STORED_WIDTH = 40;
const STORED_HEIGHT = 20;
const BLOCKS_PER_ROW = Math.ceil(STORED_WIDTH / 8);
const BLOCK_ROWS = Math.ceil(STORED_HEIGHT / 8);
const ORIENTATION = 6;
/** The DC a constant 8x8 block of this level produces: 8 * (level - 128). */
const LIGHT_DC = 8 * (200 - 128);
const DARK_DC = 8 * (100 - 128);

/** A JPEG marker segment: 0xFF, marker, big-endian length (payload + 2), payload. */
function segment(marker, payload) {
  const length = payload.length + 2;
  return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload];
}

/**
 * The DC magnitude category and its amplitude bits, as JPEG defines them: the
 * category is the number of bits the magnitude needs, and a negative amplitude
 * is stored as its ones' complement inside those bits.
 */
function dcCode(delta) {
  const magnitude = Math.abs(delta);
  const category = magnitude === 0 ? 0 : 32 - Math.clz32(magnitude);
  const amplitude = delta < 0 ? delta + (2 ** category) - 1 : delta;
  return { category, amplitude };
}

// APP1 Exif: "Exif\0\0" then a little-endian TIFF header whose IFD0 holds one
// entry, the Orientation tag (0x0112, SHORT, count 1, value 6).
const tiff = [
  0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // "II", 42, IFD0 at offset 8
  0x01, 0x00, // one IFD0 entry
  0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, // tag 0x0112, SHORT, count 1
  ORIENTATION, 0x00, 0x00, 0x00, // the value
  0x00, 0x00, 0x00, 0x00, // no next IFD
];

// The DC Huffman table holds the two categories the bands need: code 0 for a
// repeated block, code 10 for the first block of each band. (A one-bit "1" code
// would be the all-ones code the spec forbids, hence 0 and 10.)
const DC_TABLE = [0x00, 0x01, 0x01, ...new Array(14).fill(0), 0x00, 0x0a];
const DC_CODES = new Map([[0, { bits: 0b0, length: 1 }], [10, { bits: 0b10, length: 2 }]]);

const bits = [];
function write(bitsValue, length) {
  for (let shift = length - 1; shift >= 0; shift -= 1) bits.push((bitsValue >> shift) & 1);
}

let previousDc = 0;
for (let blockRow = 0; blockRow < BLOCK_ROWS; blockRow += 1) {
  const target = blockRow === 0 ? LIGHT_DC : DARK_DC;
  for (let blockColumn = 0; blockColumn < BLOCKS_PER_ROW; blockColumn += 1) {
    const { category, amplitude } = dcCode(target - previousDc);
    const code = DC_CODES.get(category);
    if (!code) throw new Error(`no DC Huffman code for category ${category}`);
    write(code.bits, code.length);
    if (category > 0) write(amplitude, category);
    write(0b0, 1); // the AC end-of-block code
    previousDc = target;
  }
}
// Pad the last byte with 1-bits, as the spec requires.
while (bits.length % 8 !== 0) bits.push(1);
const entropyBytes = [];
for (let index = 0; index < bits.length; index += 8) {
  entropyBytes.push(bits.slice(index, index + 8).reduce((value, bit) => (value << 1) | bit, 0));
}

const bytes = [
  0xff, 0xd8, // SOI
  ...segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]), // APP1 Exif
  ...segment(0xdb, [0x00, ...new Array(64).fill(1)]), // DQT, table 0, every step 1
  ...segment(0xc0, [
    0x08, // sample precision
    (STORED_HEIGHT >> 8) & 0xff, STORED_HEIGHT & 0xff,
    (STORED_WIDTH >> 8) & 0xff, STORED_WIDTH & 0xff,
    0x01, // one component
    0x01, 0x11, 0x00, // component 1, 1x1 sampling, quantisation table 0
  ]),
  ...segment(0xc4, DC_TABLE),
  // AC table 0: a single one-bit code for end-of-block.
  ...segment(0xc4, [0x10, 0x01, ...new Array(15).fill(0), 0x00]),
  ...segment(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]), // SOS, one component
  ...entropyBytes,
  0xff, 0xd9, // EOI
];

const target = fileURLToPath(new URL('./orientation6.jpg', import.meta.url));
writeFileSync(target, Buffer.from(bytes));
console.log(`wrote ${target} (${bytes.length} bytes, entropy ${entropyBytes.length} bytes)`);
