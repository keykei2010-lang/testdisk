import { computeCrc32 } from './crc32';
import { parseExifFromJpeg } from './exif';
import { stitchFragmentedVideosInBuffer } from './videoCarver';

export type FileFamily = 'Pictures' | 'Videos' | 'Documents' | 'Audio' | 'Archives' | 'Others';

export interface FileFormatDefinition {
  id: string;
  extension: string;
  description: string;
  family: FileFamily;
  mimeType: string;
  signatureHex: string;
  signatureOffset: number;
  enableByDefault: boolean;
  maxFilesize: number;
}

export interface IdentifyMetadata {
  width?: number;
  height?: number;
  details?: string;
  subExtension?: string;
  camera?: string;
  takenAtMs?: number;
  jpegValid?: {
    hasDqt: boolean;
    hasDht: boolean;
    hasSof: boolean;
    hasExif: boolean;
    hasEoi: boolean;
  };
}

export interface IdentifyResult {
  formatId: string;
  extension: string;
  description: string;
  family: FileFamily;
  mimeType: string;
  matchedOffset: number;
  matchedLength: number;
  calculatedSize: number | null;
  sizeEstimated?: boolean;
  status: 'OK' | 'OK_TRUNCATED' | 'HEADER_ONLY';
  metadata: IdentifyMetadata;
}

export interface CarvedFile {
  id: string;
  filename: string;
  recupDir: string;
  formatId: string;
  extension: string;
  description: string;
  family: FileFamily;
  mimeType: string;
  offset: number;
  sector: number;
  size: number;
  calculatedSize: number | null;
  sizeEstimated?: boolean;
  status: 'OK' | 'OK_TRUNCATED';
  metadata: IdentifyMetadata;
  data: Uint8Array;
  runs?: { offset: number; length: number }[];
  partitionId?: string;
  partitionName?: string;
  discoveryCrc32?: number;
}

export interface CarveOptions {
  startByte: number;
  endByte: number;
  blockSize: number;
  paranoid: boolean;
  keepCorrupted: boolean;
  enabledFormats: Set<string>;
  unallocatedOnly?: boolean;
  allocatedChecker?: (offset: number) => boolean;
}

export interface CarveProgress {
  currentSector: number;
  totalSectors: number;
  percent: number;
  foundCount: number;
  foundBytes: number;
  latestFile?: CarvedFile;
}

const MB = 1024 * 1024;

export const FILE_FORMATS: FileFormatDefinition[] = [
  {
    id: 'jpg',
    extension: 'jpg',
    description: 'JPG picture (JPEG / JFIF / Exif)',
    family: 'Pictures',
    mimeType: 'image/jpeg',
    signatureHex: 'FF D8 FF',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 50 * MB,
  },
  {
    id: 'png',
    extension: 'png',
    description: 'Portable Network Graphics (PNG)',
    family: 'Pictures',
    mimeType: 'image/png',
    signatureHex: '89 50 4E 47 0D 0A 1A 0A',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 50 * MB,
  },
  {
    id: 'gif',
    extension: 'gif',
    description: 'Graphics Interchange Format (GIF87a/89a)',
    family: 'Pictures',
    mimeType: 'image/gif',
    signatureHex: '47 49 46 38',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 20 * MB,
  },
  {
    id: 'bmp',
    extension: 'bmp',
    description: 'Windows Bitmap Image (BMP)',
    family: 'Pictures',
    mimeType: 'image/bmp',
    signatureHex: '42 4D',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 30 * MB,
  },
  {
    id: 'webp',
    extension: 'webp',
    description: 'WebP RIFF Image',
    family: 'Pictures',
    mimeType: 'image/webp',
    signatureHex: '52 49 46 46 ... 57 45 42 50',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 30 * MB,
  },
  {
    id: 'tiff',
    extension: 'tif',
    description: 'Tagged Image File Format (TIFF / RAW)',
    family: 'Pictures',
    mimeType: 'image/tiff',
    signatureHex: '49 49 2A 00 / 4D 4D 00 2A',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 100 * MB,
  },
  {
    id: 'cr2',
    extension: 'cr2',
    description: 'Canon Camera RAW (.cr2)',
    family: 'Pictures',
    mimeType: 'image/x-canon-cr2',
    signatureHex: '49 49 2A 00 ... 43 52 02 00',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 100 * MB,
  },
  {
    id: 'cr3',
    extension: 'cr3',
    description: 'Canon Camera RAW v3 (.cr3)',
    family: 'Pictures',
    mimeType: 'image/x-canon-cr3',
    signatureHex: '66 74 79 70 63 72 78 20',
    signatureOffset: 4,
    enableByDefault: true,
    maxFilesize: 120 * MB,
  },
  {
    id: 'nef',
    extension: 'nef',
    description: 'Nikon Electronic Format RAW (.nef)',
    family: 'Pictures',
    mimeType: 'image/x-nikon-nef',
    signatureHex: '4D 4D 00 2A / 49 49 2A 00 (NIKON)',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 100 * MB,
  },
  {
    id: 'arw',
    extension: 'arw',
    description: 'Sony Alpha Camera RAW (.arw)',
    family: 'Pictures',
    mimeType: 'image/x-sony-arw',
    signatureHex: '49 49 2A 00 (SONY)',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 120 * MB,
  },
  {
    id: 'dng',
    extension: 'dng',
    description: 'Adobe Digital Negative RAW (.dng)',
    family: 'Pictures',
    mimeType: 'image/x-adobe-dng',
    signatureHex: '49 49 2A 00 (DNGVersion 0xC612)',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 120 * MB,
  },
  {
    id: 'raf',
    extension: 'raf',
    description: 'Fujifilm Camera RAW (.raf)',
    family: 'Pictures',
    mimeType: 'image/x-fuji-raf',
    signatureHex: '46 55 4A 49 46 49 4C 4D',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 120 * MB,
  },
  {
    id: 'orf',
    extension: 'orf',
    description: 'Olympus / OM System RAW (.orf)',
    family: 'Pictures',
    mimeType: 'image/x-olympus-orf',
    signatureHex: '49 49 52 4F / 4D 4D 4F 52',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 100 * MB,
  },
  {
    id: 'rw2',
    extension: 'rw2',
    description: 'Panasonic Lumix Camera RAW (.rw2)',
    family: 'Pictures',
    mimeType: 'image/x-panasonic-rw2',
    signatureHex: '49 49 55 00',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 100 * MB,
  },
  {
    id: 'ico',
    extension: 'ico',
    description: 'Windows Icon Resource (.ico)',
    family: 'Pictures',
    mimeType: 'image/x-icon',
    signatureHex: '00 00 01 00',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 4 * MB,
  },
  {
    id: 'cur',
    extension: 'cur',
    description: 'Windows Cursor Resource (.cur)',
    family: 'Pictures',
    mimeType: 'image/x-icon',
    signatureHex: '00 00 02 00',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 4 * MB,
  },
  {
    id: 'pdf',
    extension: 'pdf',
    description: 'Portable Document Format (PDF)',
    family: 'Documents',
    mimeType: 'application/pdf',
    signatureHex: '25 50 44 46 2D 31 2E',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 100 * MB,
  },
  {
    id: 'zip',
    extension: 'zip',
    description: 'ZIP archive (including DOCX / XLSX / PPTX / APK / EPUB)',
    family: 'Archives',
    mimeType: 'application/zip',
    signatureHex: '50 4B 03 04',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 200 * MB,
  },
  {
    id: '7z',
    extension: '7z',
    description: '7-Zip compressed archive',
    family: 'Archives',
    mimeType: 'application/x-7z-compressed',
    signatureHex: '37 7A BC AF 27 1C',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 200 * MB,
  },
  {
    id: 'gz',
    extension: 'gz',
    description: 'gzip compressed data',
    family: 'Archives',
    mimeType: 'application/gzip',
    signatureHex: '1F 8B 08',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 100 * MB,
  },
  {
    id: 'rar',
    extension: 'rar',
    description: 'RAR archive (v4 / v5)',
    family: 'Archives',
    mimeType: 'application/vnd.rar',
    signatureHex: '52 61 72 21 1A 07',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 200 * MB,
  },
  {
    id: 'sqlite',
    extension: 'sqlite',
    description: 'SQLite 3.x database',
    family: 'Others',
    mimeType: 'application/vnd.sqlite3',
    signatureHex: '53 51 4C 69 74 65 20 66 6F 72 6D 61 74 20 33 00',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 200 * MB,
  },
  {
    id: 'mp4',
    extension: 'mp4',
    description: 'MPEG-4 / QuickTime ISO BMFF Video',
    family: 'Videos',
    mimeType: 'video/mp4',
    signatureHex: '66 74 79 70',
    signatureOffset: 4,
    enableByDefault: true,
    maxFilesize: 500 * MB,
  },
  {
    id: 'wav',
    extension: 'wav',
    description: 'Microsoft RIFF WAVE Audio',
    family: 'Audio',
    mimeType: 'audio/wav',
    signatureHex: '52 49 46 46 ... 57 41 56 45',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 200 * MB,
  },
  {
    id: 'avi',
    extension: 'avi',
    description: 'Microsoft RIFF AVI Video',
    family: 'Videos',
    mimeType: 'video/x-msvideo',
    signatureHex: '52 49 46 46 ... 41 56 49 20',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 500 * MB,
  },
  {
    id: 'mp3',
    extension: 'mp3',
    description: 'MPEG Audio Layer III (ID3v2)',
    family: 'Audio',
    mimeType: 'audio/mpeg',
    signatureHex: '49 44 33',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 50 * MB,
  },
  {
    id: 'flac',
    extension: 'flac',
    description: 'Free Lossless Audio Codec (FLAC)',
    family: 'Audio',
    mimeType: 'audio/flac',
    signatureHex: '66 4C 61 43',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 200 * MB,
  },
  {
    id: 'ogg',
    extension: 'ogg',
    description: 'Ogg Vorbis / Opus Container',
    family: 'Audio',
    mimeType: 'audio/ogg',
    signatureHex: '4F 67 67 53',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 200 * MB,
  },
  {
    id: 'elf',
    extension: 'elf',
    description: 'Executable and Linkable Format (ELF)',
    family: 'Others',
    mimeType: 'application/x-elf',
    signatureHex: '7F 45 4C 46',
    signatureOffset: 0,
    enableByDefault: false,
    maxFilesize: 100 * MB,
  },
  {
    id: 'exe',
    extension: 'exe',
    description: 'Windows Portable Executable (MZ/PE)',
    family: 'Others',
    mimeType: 'application/vnd.microsoft.portable-executable',
    signatureHex: '4D 5A',
    signatureOffset: 0,
    enableByDefault: false,
    maxFilesize: 100 * MB,
  },
  {
    id: 'txt',
    extension: 'txt',
    description: 'UTF-8 / ASCII Text, JSON, or XML',
    family: 'Documents',
    mimeType: 'text/plain',
    signatureHex: 'Printable UTF-8 / <?xml / {',
    signatureOffset: 0,
    enableByDefault: false,
    maxFilesize: 10 * MB,
  },
  // --- Expanded Creative, Camera, Image & Vector Formats ---
  { id: 'psd', extension: 'psd', description: 'Adobe Photoshop Document (.psd)', family: 'Pictures', mimeType: 'image/vnd.adobe.photoshop', signatureHex: '38 42 50 53 00 01', signatureOffset: 0, enableByDefault: true, maxFilesize: 300 * MB },
  { id: 'psb', extension: 'psb', description: 'Adobe Photoshop Large Document (.psb)', family: 'Pictures', mimeType: 'image/vnd.adobe.photoshop', signatureHex: '38 42 50 53 00 02', signatureOffset: 0, enableByDefault: true, maxFilesize: 500 * MB },
  { id: 'heic', extension: 'heic', description: 'High Efficiency Image Container (.heic)', family: 'Pictures', mimeType: 'image/heic', signatureHex: '66 74 79 70 68 65 69 63', signatureOffset: 4, enableByDefault: true, maxFilesize: 50 * MB },
  { id: 'avif', extension: 'avif', description: 'AV1 Image File Format (.avif)', family: 'Pictures', mimeType: 'image/avif', signatureHex: '66 74 79 70 61 76 69 66', signatureOffset: 4, enableByDefault: true, maxFilesize: 40 * MB },
  { id: 'jxl', extension: 'jxl', description: 'JPEG XL Image (.jxl)', family: 'Pictures', mimeType: 'image/jxl', signatureHex: 'FF 0A / 00 00 00 0C 4A 58 4C 20', signatureOffset: 0, enableByDefault: true, maxFilesize: 80 * MB },
  { id: 'exr', extension: 'exr', description: 'OpenEXR HDR Image (.exr)', family: 'Pictures', mimeType: 'image/x-exr', signatureHex: '76 2F 31 01', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'hdr', extension: 'hdr', description: 'Radiance RGBE HDR Image (.hdr)', family: 'Pictures', mimeType: 'image/vnd.radiance', signatureHex: '23 3F 52 41 44 49 41 4E 43 45', signatureOffset: 0, enableByDefault: true, maxFilesize: 80 * MB },
  { id: 'dds', extension: 'dds', description: 'DirectDraw Surface Texture (.dds)', family: 'Pictures', mimeType: 'image/vnd.ms-dds', signatureHex: '44 44 53 20 7C 00 00 00', signatureOffset: 0, enableByDefault: true, maxFilesize: 100 * MB },
  { id: 'tga', extension: 'tga', description: 'Truevision TARGA Image (.tga)', family: 'Pictures', mimeType: 'image/x-tga', signatureHex: 'TRUEVISION-XFILE (footer)', signatureOffset: 0, enableByDefault: false, maxFilesize: 40 * MB },
  { id: 'svg', extension: 'svg', description: 'Scalable Vector Graphics (.svg)', family: 'Pictures', mimeType: 'image/svg+xml', signatureHex: '3C 73 76 67', signatureOffset: 0, enableByDefault: false, maxFilesize: 10 * MB },
  { id: 'cdr', extension: 'cdr', description: 'CorelDRAW Vector Drawing (.cdr)', family: 'Pictures', mimeType: 'application/x-cdr', signatureHex: '52 49 46 46 ... 43 44 52', signatureOffset: 0, enableByDefault: true, maxFilesize: 100 * MB },
  { id: 'ani', extension: 'ani', description: 'Windows Animated Cursor (.ani)', family: 'Pictures', mimeType: 'application/x-navi-animation', signatureHex: '52 49 46 46 ... 41 43 4F 4E', signatureOffset: 0, enableByDefault: true, maxFilesize: 4 * MB },
  { id: 'eps', extension: 'eps', description: 'Encapsulated PostScript (.eps)', family: 'Pictures', mimeType: 'application/postscript', signatureHex: 'C5 D0 D3 C6 / %!PS-Adobe', signatureOffset: 0, enableByDefault: true, maxFilesize: 60 * MB },
  { id: 'kra', extension: 'kra', description: 'Krita Digital Painting (.kra)', family: 'Pictures', mimeType: 'application/x-krita', signatureHex: '50 4B 03 04 (application/x-krita)', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'ora', extension: 'ora', description: 'OpenRaster Layered Image (.ora)', family: 'Pictures', mimeType: 'image/openraster', signatureHex: '50 4B 03 04 (image/openraster)', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'xcf', extension: 'xcf', description: 'GIMP XCF Image Project (.xcf)', family: 'Pictures', mimeType: 'image/x-xcf', signatureHex: '67 69 6D 70 20 78 63 66', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'qoi', extension: 'qoi', description: 'Quite OK Image (.qoi)', family: 'Pictures', mimeType: 'image/qoi', signatureHex: '71 6F 69 66', signatureOffset: 0, enableByDefault: true, maxFilesize: 40 * MB },
  { id: 'bpg', extension: 'bpg', description: 'Better Portable Graphics (.bpg)', family: 'Pictures', mimeType: 'image/bpg', signatureHex: '42 50 47 FB', signatureOffset: 0, enableByDefault: true, maxFilesize: 20 * MB },
  { id: 'dpx', extension: 'dpx', description: 'Digital Picture Exchange Frame (.dpx)', family: 'Pictures', mimeType: 'image/x-dpx', signatureHex: '53 44 50 58 / 58 50 44 53', signatureOffset: 0, enableByDefault: true, maxFilesize: 100 * MB },
  { id: 'pcx', extension: 'pcx', description: 'ZSoft PC Paintbrush Image (.pcx)', family: 'Pictures', mimeType: 'image/x-pcx', signatureHex: '0A 05 01 08', signatureOffset: 0, enableByDefault: false, maxFilesize: 20 * MB },
  { id: 'icns', extension: 'icns', description: 'Apple Icon Image (.icns)', family: 'Pictures', mimeType: 'image/icns', signatureHex: '69 63 6E 73', signatureOffset: 0, enableByDefault: true, maxFilesize: 10 * MB },
  { id: 'sr2', extension: 'sr2', description: 'Sony RAW SR2 (.sr2)', family: 'Pictures', mimeType: 'image/x-sony-sr2', signatureHex: '49 49 2A 00 (SONY)', signatureOffset: 0, enableByDefault: true, maxFilesize: 100 * MB },
  { id: 'pef', extension: 'pef', description: 'Pentax Electronic Format RAW (.pef)', family: 'Pictures', mimeType: 'image/x-pentax-pef', signatureHex: '4D 4D 00 2A (PENTAX)', signatureOffset: 0, enableByDefault: true, maxFilesize: 100 * MB },
  { id: 'mrw', extension: 'mrw', description: 'Minolta Camera RAW (.mrw)', family: 'Pictures', mimeType: 'image/x-minolta-mrw', signatureHex: '00 4D 52 4D', signatureOffset: 0, enableByDefault: true, maxFilesize: 80 * MB },
  { id: 'kdc', extension: 'kdc', description: 'Kodak Digital Camera RAW (.kdc)', family: 'Pictures', mimeType: 'image/x-kodak-kdc', signatureHex: '4D 4D 00 2A (KODAK)', signatureOffset: 0, enableByDefault: true, maxFilesize: 80 * MB },
  { id: '3fr', extension: '3fr', description: 'Hasselblad 3FR RAW (.3fr)', family: 'Pictures', mimeType: 'image/x-hasselblad-3fr', signatureHex: '49 49 2A 00 (Hasselblad)', signatureOffset: 0, enableByDefault: true, maxFilesize: 150 * MB },
  { id: 'x3f', extension: 'x3f', description: 'Sigma Foveon X3F RAW (.x3f)', family: 'Pictures', mimeType: 'image/x-sigma-x3f', signatureHex: '46 4F 56 62', signatureOffset: 0, enableByDefault: true, maxFilesize: 100 * MB },
  // --- Creative Projects, 3D & CAD ---
  { id: 'aep', extension: 'aep', description: 'Adobe After Effects Project (.aep)', family: 'Others', mimeType: 'application/x-after-effects', signatureHex: '52 49 46 58 ... 45 67 67 21', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'aepx', extension: 'aepx', description: 'Adobe After Effects XML Project (.aepx)', family: 'Documents', mimeType: 'application/xml', signatureHex: 'AfterEffectsProject XML', signatureOffset: 0, enableByDefault: true, maxFilesize: 50 * MB },
  { id: 'prproj', extension: 'prproj', description: 'Adobe Premiere Pro Project (.prproj)', family: 'Others', mimeType: 'application/x-premiere', signatureHex: '1F 8B 08 (PremiereData)', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'dwg', extension: 'dwg', description: 'AutoCAD Drawing (.dwg)', family: 'Others', mimeType: 'image/vnd.dwg', signatureHex: '41 43 31 30', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'dxf', extension: 'dxf', description: 'AutoCAD Drawing Exchange Format (.dxf)', family: 'Documents', mimeType: 'image/vnd.dxf', signatureHex: '0\\nSECTION', signatureOffset: 0, enableByDefault: false, maxFilesize: 50 * MB },
  { id: 'blend', extension: 'blend', description: 'Blender 3D Project (.blend)', family: 'Others', mimeType: 'application/x-blender', signatureHex: '42 4C 45 4E 44 45 52', signatureOffset: 0, enableByDefault: true, maxFilesize: 500 * MB },
  { id: 'fbx', extension: 'fbx', description: 'Autodesk FBX 3D Model (.fbx)', family: 'Others', mimeType: 'application/octet-stream', signatureHex: '4B 61 79 64 61 72 61 20 46 42 58 20 42 69 6E 61 72 79', signatureOffset: 0, enableByDefault: true, maxFilesize: 300 * MB },
  { id: 'glb', extension: 'glb', description: 'glTF 2.0 Binary 3D Scene (.glb)', family: 'Others', mimeType: 'model/gltf-binary', signatureHex: '67 6C 54 46 02 00 00 00', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'stl', extension: 'stl', description: 'Stereolithography 3D Mesh (.stl)', family: 'Others', mimeType: 'model/stl', signatureHex: '73 6F 6C 69 64 20', signatureOffset: 0, enableByDefault: false, maxFilesize: 100 * MB },
  { id: '3ds', extension: '3ds', description: 'Autodesk 3D Studio Mesh (.3ds)', family: 'Others', mimeType: 'application/x-3ds', signatureHex: '4D 4D ... 3D 3D', signatureOffset: 0, enableByDefault: false, maxFilesize: 100 * MB },
  // --- Expanded Video & Broadcast Containers ---
  { id: 'mov', extension: 'mov', description: 'Apple QuickTime Movie (.mov)', family: 'Videos', mimeType: 'video/quicktime', signatureHex: '66 74 79 70 71 74 20 20', signatureOffset: 4, enableByDefault: true, maxFilesize: 500 * MB },
  { id: 'm4v', extension: 'm4v', description: 'Apple M4V Video Container (.m4v)', family: 'Videos', mimeType: 'video/x-m4v', signatureHex: '66 74 79 70 4D 34 56 20', signatureOffset: 4, enableByDefault: true, maxFilesize: 500 * MB },
  { id: '3gp', extension: '3gp', description: '3GPP Mobile Video (.3gp)', family: 'Videos', mimeType: 'video/3gpp', signatureHex: '66 74 79 70 33 67 70', signatureOffset: 4, enableByDefault: true, maxFilesize: 500 * MB },
  { id: '3g2', extension: '3g2', description: '3GPP2 Mobile Video (.3g2)', family: 'Videos', mimeType: 'video/3gpp2', signatureHex: '66 74 79 70 33 67 32', signatureOffset: 4, enableByDefault: true, maxFilesize: 500 * MB },
  { id: 'mkv', extension: 'mkv', description: 'Matroska Video Container (.mkv)', family: 'Videos', mimeType: 'video/x-matroska', signatureHex: '1A 45 DF A3', signatureOffset: 0, enableByDefault: true, maxFilesize: 500 * MB },
  { id: 'webm', extension: 'webm', description: 'WebM Matroska Video (.webm)', family: 'Videos', mimeType: 'video/webm', signatureHex: '1A 45 DF A3 (webm)', signatureOffset: 0, enableByDefault: true, maxFilesize: 500 * MB },
  { id: 'flv', extension: 'flv', description: 'Adobe Flash Video (.flv)', family: 'Videos', mimeType: 'video/x-flv', signatureHex: '46 4C 56 01', signatureOffset: 0, enableByDefault: true, maxFilesize: 500 * MB },
  { id: 'wmv', extension: 'wmv', description: 'Windows Media Video (.wmv / ASF)', family: 'Videos', mimeType: 'video/x-ms-wmv', signatureHex: '30 26 B2 75 8E 66 CF 11', signatureOffset: 0, enableByDefault: true, maxFilesize: 500 * MB },
  { id: 'mxf', extension: 'mxf', description: 'SMPTE Material eXchange Format (.mxf)', family: 'Videos', mimeType: 'application/mxf', signatureHex: '06 0E 2B 34 02 05 01 01', signatureOffset: 0, enableByDefault: true, maxFilesize: 500 * MB },
  { id: 'ts', extension: 'ts', description: 'MPEG-2 Transport Stream (.ts / AVCHD)', family: 'Videos', mimeType: 'video/mp2t', signatureHex: '47 xx ... (+188) 47', signatureOffset: 0, enableByDefault: true, maxFilesize: 500 * MB },
  { id: 'mpg', extension: 'mpg', description: 'MPEG-1/2 Program Stream (.mpg / .vob)', family: 'Videos', mimeType: 'video/mpeg', signatureHex: '00 00 01 BA', signatureOffset: 0, enableByDefault: true, maxFilesize: 500 * MB },
  { id: 'vob', extension: 'vob', description: 'DVD Video Object (.vob)', family: 'Videos', mimeType: 'video/dvd', signatureHex: '00 00 01 BA (DVD)', signatureOffset: 0, enableByDefault: true, maxFilesize: 500 * MB },
  { id: 'rmvb', extension: 'rmvb', description: 'RealMedia Variable Bitrate (.rmvb / .rm)', family: 'Videos', mimeType: 'application/vnd.rn-realmedia', signatureHex: '2E 52 4D 46', signatureOffset: 0, enableByDefault: true, maxFilesize: 500 * MB },
  { id: 'ogv', extension: 'ogv', description: 'Ogg Theora Video (.ogv)', family: 'Videos', mimeType: 'video/ogg', signatureHex: '4F 67 67 53 (theora)', signatureOffset: 0, enableByDefault: true, maxFilesize: 300 * MB },
  { id: 'swf', extension: 'swf', description: 'Adobe Shockwave Flash (.swf)', family: 'Videos', mimeType: 'application/x-shockwave-flash', signatureHex: '46 57 53 / 43 57 53', signatureOffset: 0, enableByDefault: false, maxFilesize: 100 * MB },
  { id: 'mts', extension: 'mts', description: 'AVCHD Blu-ray Video (.mts / .m2ts)', family: 'Videos', mimeType: 'video/mp2t', signatureHex: '00 00 00 ... 47 (+192)', signatureOffset: 0, enableByDefault: true, maxFilesize: 500 * MB },
  { id: 'braw', extension: 'braw', description: 'Blackmagic RAW Video (.braw)', family: 'Videos', mimeType: 'video/x-braw', signatureHex: '66 74 79 70 62 72 61 77', signatureOffset: 4, enableByDefault: true, maxFilesize: 500 * MB },
  { id: 'r3d', extension: 'r3d', description: 'RED Digital Cinema RAW (.r3d)', family: 'Videos', mimeType: 'video/x-r3d', signatureHex: '00 00 ... 52 45 44 32', signatureOffset: 0, enableByDefault: true, maxFilesize: 500 * MB },
  // --- Expanded Documents, Office, Ebooks, Mail & Databases ---
  { id: 'docx', extension: 'docx', description: 'Microsoft Word OpenXML Document (.docx)', family: 'Documents', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', signatureHex: '50 4B 03 04 (word/)', signatureOffset: 0, enableByDefault: true, maxFilesize: 100 * MB },
  { id: 'xlsx', extension: 'xlsx', description: 'Microsoft Excel OpenXML Workbook (.xlsx)', family: 'Documents', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', signatureHex: '50 4B 03 04 (xl/)', signatureOffset: 0, enableByDefault: true, maxFilesize: 100 * MB },
  { id: 'pptx', extension: 'pptx', description: 'Microsoft PowerPoint OpenXML Deck (.pptx)', family: 'Documents', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', signatureHex: '50 4B 03 04 (ppt/)', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'doc', extension: 'doc', description: 'Microsoft Word OLE2 Document (.doc)', family: 'Documents', mimeType: 'application/msword', signatureHex: 'D0 CF 11 E0 A1 B1 1A E1 (WordDocument)', signatureOffset: 0, enableByDefault: true, maxFilesize: 100 * MB },
  { id: 'xls', extension: 'xls', description: 'Microsoft Excel OLE2 Workbook (.xls)', family: 'Documents', mimeType: 'application/vnd.ms-excel', signatureHex: 'D0 CF 11 E0 A1 B1 1A E1 (Workbook)', signatureOffset: 0, enableByDefault: true, maxFilesize: 100 * MB },
  { id: 'ppt', extension: 'ppt', description: 'Microsoft PowerPoint OLE2 Deck (.ppt)', family: 'Documents', mimeType: 'application/vnd.ms-powerpoint', signatureHex: 'D0 CF 11 E0 A1 B1 1A E1 (PowerPoint Document)', signatureOffset: 0, enableByDefault: true, maxFilesize: 150 * MB },
  { id: 'msg', extension: 'msg', description: 'Microsoft Outlook OLE2 Email (.msg)', family: 'Documents', mimeType: 'application/vnd.ms-outlook', signatureHex: 'D0 CF 11 E0 A1 B1 1A E1 (__substg1.0)', signatureOffset: 0, enableByDefault: true, maxFilesize: 50 * MB },
  { id: 'msi', extension: 'msi', description: 'Windows Installer Package (.msi)', family: 'Archives', mimeType: 'application/x-msi', signatureHex: 'D0 CF 11 E0 A1 B1 1A E1', signatureOffset: 0, enableByDefault: false, maxFilesize: 200 * MB },
  { id: 'odt', extension: 'odt', description: 'OpenDocument Text (.odt)', family: 'Documents', mimeType: 'application/vnd.oasis.opendocument.text', signatureHex: '50 4B 03 04 (opendocument.text)', signatureOffset: 0, enableByDefault: true, maxFilesize: 80 * MB },
  { id: 'ods', extension: 'ods', description: 'OpenDocument Spreadsheet (.ods)', family: 'Documents', mimeType: 'application/vnd.oasis.opendocument.spreadsheet', signatureHex: '50 4B 03 04 (opendocument.spreadsheet)', signatureOffset: 0, enableByDefault: true, maxFilesize: 80 * MB },
  { id: 'odp', extension: 'odp', description: 'OpenDocument Presentation (.odp)', family: 'Documents', mimeType: 'application/vnd.oasis.opendocument.presentation', signatureHex: '50 4B 03 04 (opendocument.presentation)', signatureOffset: 0, enableByDefault: true, maxFilesize: 120 * MB },
  { id: 'epub', extension: 'epub', description: 'EPUB Digital Book (.epub)', family: 'Documents', mimeType: 'application/epub+zip', signatureHex: '50 4B 03 04 (epub+zip)', signatureOffset: 0, enableByDefault: true, maxFilesize: 100 * MB },
  { id: 'rtf', extension: 'rtf', description: 'Rich Text Format Document (.rtf)', family: 'Documents', mimeType: 'application/rtf', signatureHex: '7B 5C 72 74 66 31', signatureOffset: 0, enableByDefault: true, maxFilesize: 40 * MB },
  { id: 'pst', extension: 'pst', description: 'Microsoft Outlook Personal Folder (.pst)', family: 'Documents', mimeType: 'application/vnd.ms-outlook-pst', signatureHex: '21 42 44 4E', signatureOffset: 0, enableByDefault: true, maxFilesize: 500 * MB },
  { id: 'ost', extension: 'ost', description: 'Microsoft Outlook Offline Store (.ost)', family: 'Documents', mimeType: 'application/vnd.ms-outlook-pst', signatureHex: '21 42 44 4E (OST)', signatureOffset: 0, enableByDefault: true, maxFilesize: 500 * MB },
  { id: 'eml', extension: 'eml', description: 'RFC 822 Email Message (.eml)', family: 'Documents', mimeType: 'message/rfc822', signatureHex: 'From: / Return-Path: / MIME-Version:', signatureOffset: 0, enableByDefault: false, maxFilesize: 20 * MB },
  { id: 'mbox', extension: 'mbox', description: 'Thunderbird / Unix Mail Archive (.mbox)', family: 'Documents', mimeType: 'application/mbox', signatureHex: '46 72 6F 6D 20', signatureOffset: 0, enableByDefault: false, maxFilesize: 200 * MB },
  { id: 'vcf', extension: 'vcf', description: 'vCard Contact File (.vcf)', family: 'Documents', mimeType: 'text/vcard', signatureHex: '42 45 47 49 4E 3A 56 43 41 52 44', signatureOffset: 0, enableByDefault: false, maxFilesize: 4 * MB },
  { id: 'ics', extension: 'ics', description: 'iCalendar Event File (.ics)', family: 'Documents', mimeType: 'text/calendar', signatureHex: '42 45 47 49 4E 3A 56 43 41 4C 45 4E 44 41 52', signatureOffset: 0, enableByDefault: false, maxFilesize: 4 * MB },
  { id: 'djvu', extension: 'djvu', description: 'DjVu Scanned Document (.djvu)', family: 'Documents', mimeType: 'image/vnd.djvu', signatureHex: '41 54 26 54 46 4F 52 4D', signatureOffset: 0, enableByDefault: true, maxFilesize: 100 * MB },
  { id: 'mobi', extension: 'mobi', description: 'Mobipocket / Kindle Ebook (.mobi)', family: 'Documents', mimeType: 'application/x-mobipocket-ebook', signatureHex: '42 4F 4F 4B 4D 4F 42 49', signatureOffset: 60, enableByDefault: true, maxFilesize: 80 * MB },
  { id: 'xml', extension: 'xml', description: 'Extensible Markup Document (.xml)', family: 'Documents', mimeType: 'application/xml', signatureHex: '3C 3F 78 6D 6C', signatureOffset: 0, enableByDefault: false, maxFilesize: 20 * MB },
  { id: 'json', extension: 'json', description: 'JSON Structured Data (.json)', family: 'Documents', mimeType: 'application/json', signatureHex: '7B 22 / UTF-8 JSON', signatureOffset: 0, enableByDefault: false, maxFilesize: 20 * MB },
  { id: 'html', extension: 'html', description: 'HTML Document / Browser Bookmarks (.html)', family: 'Documents', mimeType: 'text/html', signatureHex: '3C 21 44 4F 43 54 59 50 45', signatureOffset: 0, enableByDefault: false, maxFilesize: 20 * MB },
  { id: 'one', extension: 'one', description: 'Microsoft OneNote Section (.one)', family: 'Documents', mimeType: 'application/onenote', signatureHex: 'E4 52 5C 7B 8C D8 A7 4D', signatureOffset: 0, enableByDefault: true, maxFilesize: 100 * MB },
  { id: 'pub', extension: 'pub', description: 'Microsoft Publisher Document (.pub)', family: 'Documents', mimeType: 'application/x-mspublisher', signatureHex: 'D0 CF 11 E0 (Quill)', signatureOffset: 0, enableByDefault: true, maxFilesize: 100 * MB },
  { id: 'mdb', extension: 'mdb', description: 'Microsoft Access Jet Database (.mdb)', family: 'Others', mimeType: 'application/x-msaccess', signatureHex: '00 01 00 00 53 74 61 6E 64 61 72 64 20 4A 65 74', signatureOffset: 0, enableByDefault: true, maxFilesize: 300 * MB },
  { id: 'accdb', extension: 'accdb', description: 'Microsoft Access ACE Database (.accdb)', family: 'Others', mimeType: 'application/x-msaccess', signatureHex: '00 01 00 00 53 74 61 6E 64 61 72 64 20 41 43 45', signatureOffset: 0, enableByDefault: true, maxFilesize: 300 * MB },
  // --- Expanded Audio Formats ---
  { id: 'm4a', extension: 'm4a', description: 'MPEG-4 AAC Audio (.m4a)', family: 'Audio', mimeType: 'audio/mp4', signatureHex: '66 74 79 70 4D 34 41 20', signatureOffset: 4, enableByDefault: true, maxFilesize: 100 * MB },
  { id: 'm4b', extension: 'm4b', description: 'MPEG-4 Audiobook (.m4b)', family: 'Audio', mimeType: 'audio/mp4', signatureHex: '66 74 79 70 4D 34 42 20', signatureOffset: 4, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'aiff', extension: 'aiff', description: 'Apple Audio Interchange (.aiff)', family: 'Audio', mimeType: 'audio/aiff', signatureHex: '46 4F 52 4D ... 41 49 46 46', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'opus', extension: 'opus', description: 'Opus Ogg Audio (.opus)', family: 'Audio', mimeType: 'audio/opus', signatureHex: '4F 67 67 53 (OpusHead)', signatureOffset: 0, enableByDefault: true, maxFilesize: 100 * MB },
  { id: 'mid', extension: 'mid', description: 'Standard MIDI Musical Sequence (.mid)', family: 'Audio', mimeType: 'audio/midi', signatureHex: '4D 54 68 64 00 00 00 06', signatureOffset: 0, enableByDefault: true, maxFilesize: 10 * MB },
  { id: 'amr', extension: 'amr', description: 'Adaptive Multi-Rate Voice Recording (.amr)', family: 'Audio', mimeType: 'audio/amr', signatureHex: '23 21 41 4D 52', signatureOffset: 0, enableByDefault: true, maxFilesize: 40 * MB },
  { id: 'ape', extension: 'ape', description: "Monkey's Audio Lossless (.ape)", family: 'Audio', mimeType: 'audio/x-ape', signatureHex: '4D 41 43 20', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'wv', extension: 'wv', description: 'WavPack Lossless Audio (.wv)', family: 'Audio', mimeType: 'audio/x-wavpack', signatureHex: '77 76 70 6B', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'wma', extension: 'wma', description: 'Windows Media Audio (.wma / ASF)', family: 'Audio', mimeType: 'audio/x-ms-wma', signatureHex: '30 26 B2 75 (Audio)', signatureOffset: 0, enableByDefault: true, maxFilesize: 100 * MB },
  { id: 'aac', extension: 'aac', description: 'Raw ADTS AAC Audio Frame Stream (.aac)', family: 'Audio', mimeType: 'audio/aac', signatureHex: 'FF F1 / FF F9', signatureOffset: 0, enableByDefault: false, maxFilesize: 50 * MB },
  { id: 'caf', extension: 'caf', description: 'Apple Core Audio Format (.caf)', family: 'Audio', mimeType: 'audio/x-caf', signatureHex: '63 61 66 66', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  // --- Expanded Archives, Packages & Disk Images ---
  { id: 'apk', extension: 'apk', description: 'Android Application Package (.apk)', family: 'Archives', mimeType: 'application/vnd.android.package-archive', signatureHex: '50 4B 03 04 (AndroidManifest)', signatureOffset: 0, enableByDefault: true, maxFilesize: 300 * MB },
  { id: 'jar', extension: 'jar', description: 'Java Archive Package (.jar)', family: 'Archives', mimeType: 'application/java-archive', signatureHex: '50 4B 03 04 (META-INF/)', signatureOffset: 0, enableByDefault: true, maxFilesize: 100 * MB },
  { id: 'kmz', extension: 'kmz', description: 'Google Earth Placemark Archive (.kmz)', family: 'Archives', mimeType: 'application/vnd.google-earth.kmz', signatureHex: '50 4B 03 04 (.kml)', signatureOffset: 0, enableByDefault: true, maxFilesize: 50 * MB },
  { id: 'cab', extension: 'cab', description: 'Microsoft Cabinet Archive (.cab)', family: 'Archives', mimeType: 'application/vnd.ms-cab-compressed', signatureHex: '4D 53 43 46', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'zst', extension: 'zst', description: 'Zstandard Compressed Archive (.zst)', family: 'Archives', mimeType: 'application/zstd', signatureHex: '28 B5 2F FD', signatureOffset: 0, enableByDefault: true, maxFilesize: 300 * MB },
  { id: 'lz4', extension: 'lz4', description: 'LZ4 Frame Archive (.lz4)', family: 'Archives', mimeType: 'application/x-lz4', signatureHex: '04 22 4D 18', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'xz', extension: 'xz', description: 'XZ / LZMA2 Compressed Data (.xz)', family: 'Archives', mimeType: 'application/x-xz', signatureHex: 'FD 37 7A 58 5A 00', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'bz2', extension: 'bz2', description: 'Bzip2 Compressed Archive (.bz2)', family: 'Archives', mimeType: 'application/x-bzip2', signatureHex: '42 5A 68', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'tar', extension: 'tar', description: 'POSIX USTAR Tape Archive (.tar)', family: 'Archives', mimeType: 'application/x-tar', signatureHex: '75 73 74 61 72', signatureOffset: 257, enableByDefault: true, maxFilesize: 300 * MB },
  { id: 'iso', extension: 'iso', description: 'ISO-9660 Optical Disc Image (.iso)', family: 'Archives', mimeType: 'application/x-iso9660-image', signatureHex: '43 44 30 30 31', signatureOffset: 32769, enableByDefault: true, maxFilesize: 500 * MB },
  { id: 'rpm', extension: 'rpm', description: 'Red Hat Package Manager (.rpm)', family: 'Archives', mimeType: 'application/x-rpm', signatureHex: 'ED AB EE DB', signatureOffset: 0, enableByDefault: false, maxFilesize: 200 * MB },
  { id: 'deb', extension: 'deb', description: 'Debian Binary Package (.deb)', family: 'Archives', mimeType: 'application/vnd.debian.binary-package', signatureHex: '21 3C 61 72 63 68 3E 0A', signatureOffset: 0, enableByDefault: false, maxFilesize: 200 * MB },
  { id: 'lzh', extension: 'lzh', description: 'LHA / LZH Archive (.lzh)', family: 'Archives', mimeType: 'application/x-lzh-compressed', signatureHex: '2D 6C 68', signatureOffset: 2, enableByDefault: false, maxFilesize: 100 * MB },
  { id: 'rpa', extension: 'rpa', description: "Ren'Py Game Asset Archive (.rpa)", family: 'Archives', mimeType: 'application/x-renpy-archive', signatureHex: '52 50 41 2D 33 2E 30', signatureOffset: 0, enableByDefault: true, maxFilesize: 500 * MB },
  { id: 'asar', extension: 'asar', description: 'Electron ASAR Resource Archive (.asar)', family: 'Archives', mimeType: 'application/x-asar', signatureHex: '04 00 00 00 ... {"files":', signatureOffset: 0, enableByDefault: false, maxFilesize: 200 * MB },
  { id: 'vhd', extension: 'vhd', description: 'Microsoft Virtual Hard Disk (.vhd footer)', family: 'Archives', mimeType: 'application/x-vhd', signatureHex: '63 6F 6E 65 63 74 69 78', signatureOffset: 0, enableByDefault: false, maxFilesize: 500 * MB },
  { id: 'vmdk', extension: 'vmdk', description: 'VMware Virtual Disk Descriptor (.vmdk)', family: 'Archives', mimeType: 'application/x-vmdk', signatureHex: '4B 44 4D 56', signatureOffset: 0, enableByDefault: false, maxFilesize: 500 * MB },
  // --- Windows System, Forensics, Game Engine, Fonts, Keys & Dev ---
  { id: 'evtx', extension: 'evtx', description: 'Windows XML Event Log (.evtx)', family: 'Others', mimeType: 'application/octet-stream', signatureHex: '45 6C 66 46 69 6C 65 00', signatureOffset: 0, enableByDefault: true, maxFilesize: 100 * MB },
  { id: 'evt', extension: 'evt', description: 'Legacy Windows Event Log (.evt)', family: 'Others', mimeType: 'application/octet-stream', signatureHex: '30 00 00 00 4C 66 4C 65', signatureOffset: 0, enableByDefault: false, maxFilesize: 64 * MB },
  { id: 'reg', extension: 'reg', description: 'Windows Registry Hive File (regf)', family: 'Others', mimeType: 'application/octet-stream', signatureHex: '72 65 67 66', signatureOffset: 0, enableByDefault: false, maxFilesize: 200 * MB },
  { id: 'lnk', extension: 'lnk', description: 'Windows Shell Shortcut (.lnk)', family: 'Others', mimeType: 'application/x-ms-shortcut', signatureHex: '4C 00 00 00 01 14 02 00', signatureOffset: 0, enableByDefault: true, maxFilesize: 1 * MB },
  { id: 'pf', extension: 'pf', description: 'Windows Prefetch Execution Trace (.pf)', family: 'Others', mimeType: 'application/octet-stream', signatureHex: '4D 41 4D 04 / SCCA', signatureOffset: 0, enableByDefault: false, maxFilesize: 8 * MB },
  { id: 'pcap', extension: 'pcap', description: 'Wireshark / libpcap Packet Capture (.pcap)', family: 'Others', mimeType: 'application/vnd.tcpdump.pcap', signatureHex: 'D4 C3 B2 A1 / A1 B2 C3 D4', signatureOffset: 0, enableByDefault: true, maxFilesize: 300 * MB },
  { id: 'pcapng', extension: 'pcapng', description: 'PCAP Next-Generation Capture (.pcapng)', family: 'Others', mimeType: 'application/x-pcapng', signatureHex: '0A 0D 0D 0A ... 4D 3C 2B 1A', signatureOffset: 0, enableByDefault: true, maxFilesize: 300 * MB },
  { id: 'rpyc', extension: 'rpyc', description: "Ren'Py Compiled Script (.rpyc)", family: 'Others', mimeType: 'application/octet-stream', signatureHex: '52 45 4E 50 59 20 52 50 43 32', signatureOffset: 0, enableByDefault: true, maxFilesize: 20 * MB },
  { id: 'rpy', extension: 'rpy', description: "Ren'Py Script Source (.rpy)", family: 'Documents', mimeType: 'text/plain', signatureHex: 'label start: / init python:', signatureOffset: 0, enableByDefault: false, maxFilesize: 10 * MB },
  { id: 'wasm', extension: 'wasm', description: 'WebAssembly Binary Module (.wasm)', family: 'Others', mimeType: 'application/wasm', signatureHex: '00 61 73 6D 01 00 00 00', signatureOffset: 0, enableByDefault: false, maxFilesize: 50 * MB },
  { id: 'class', extension: 'class', description: 'Java Compiled Bytecode (.class)', family: 'Others', mimeType: 'application/java-vm', signatureHex: 'CA FE BA BE', signatureOffset: 0, enableByDefault: false, maxFilesize: 10 * MB },
  { id: 'macho', extension: 'macho', description: 'Mach-O Executable Binary', family: 'Others', mimeType: 'application/x-mach-binary', signatureHex: 'CF FA ED FE / FE ED FA CF', signatureOffset: 0, enableByDefault: false, maxFilesize: 100 * MB },
  { id: 'dex', extension: 'dex', description: 'Android Dalvik Executable (.dex)', family: 'Others', mimeType: 'application/vnd.android.dex', signatureHex: '64 65 78 0A 30 33', signatureOffset: 0, enableByDefault: false, maxFilesize: 50 * MB },
  { id: 'ttf', extension: 'ttf', description: 'TrueType Font (.ttf)', family: 'Others', mimeType: 'font/ttf', signatureHex: '00 01 00 00 00', signatureOffset: 0, enableByDefault: false, maxFilesize: 30 * MB },
  { id: 'otf', extension: 'otf', description: 'OpenType Font (.otf)', family: 'Others', mimeType: 'font/otf', signatureHex: '4F 54 54 4F', signatureOffset: 0, enableByDefault: true, maxFilesize: 30 * MB },
  { id: 'woff', extension: 'woff', description: 'Web Open Font Format (.woff)', family: 'Others', mimeType: 'font/woff', signatureHex: '77 4F 46 46', signatureOffset: 0, enableByDefault: true, maxFilesize: 20 * MB },
  { id: 'woff2', extension: 'woff2', description: 'Web Open Font Format 2 (.woff2)', family: 'Others', mimeType: 'font/woff2', signatureHex: '77 4F 46 32', signatureOffset: 0, enableByDefault: true, maxFilesize: 20 * MB },
  { id: 'torrent', extension: 'torrent', description: 'BitTorrent Metainfo File (.torrent)', family: 'Others', mimeType: 'application/x-bittorrent', signatureHex: '64 38 3A 61 6E 6E 6F 75 6E 63 65', signatureOffset: 0, enableByDefault: true, maxFilesize: 10 * MB },
  { id: 'pem', extension: 'pem', description: 'X.509 Certificate / Private Key (.pem)', family: 'Documents', mimeType: 'application/x-pem-file', signatureHex: '2D 2D 2D 2D 2D 42 45 47 49 4E', signatureOffset: 0, enableByDefault: false, maxFilesize: 1 * MB },
  { id: 'pgp', extension: 'pgp', description: 'PGP / GPG Encrypted Key/Message (.pgp)', family: 'Others', mimeType: 'application/pgp-encrypted', signatureHex: '-----BEGIN PGP', signatureOffset: 0, enableByDefault: false, maxFilesize: 50 * MB },
  { id: 'dat', extension: 'dat', description: 'Windows NTUSER / Generic Registry Data', family: 'Others', mimeType: 'application/octet-stream', signatureHex: '72 65 67 66 (NTUSER)', signatureOffset: 0, enableByDefault: false, maxFilesize: 200 * MB },
  { id: 'db', extension: 'db', description: 'Thumbs.db / SQLite Database (.db)', family: 'Others', mimeType: 'application/octet-stream', signatureHex: 'SQLite / OLE2 Thumbs.db', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'py', extension: 'py', description: 'Python Script Source (.py)', family: 'Documents', mimeType: 'text/x-python', signatureHex: '#!/usr/bin/env python / def ', signatureOffset: 0, enableByDefault: false, maxFilesize: 5 * MB },
  { id: 'csv', extension: 'csv', description: 'Comma-Separated Values Table (.csv)', family: 'Documents', mimeType: 'text/csv', signatureHex: 'UTF-8 Delimited Table', signatureOffset: 0, enableByDefault: false, maxFilesize: 20 * MB },
  { id: 'sql', extension: 'sql', description: 'SQL Database Dump (.sql)', family: 'Documents', mimeType: 'application/sql', signatureHex: 'CREATE TABLE / INSERT INTO', signatureOffset: 0, enableByDefault: false, maxFilesize: 100 * MB },
  { id: 'ini', extension: 'ini', description: 'Windows Configuration File (.ini)', family: 'Documents', mimeType: 'text/plain', signatureHex: '[Section] Config Text', signatureOffset: 0, enableByDefault: false, maxFilesize: 2 * MB },
  { id: 'chm', extension: 'chm', description: 'Microsoft Compiled HTML Help (.chm)', family: 'Documents', mimeType: 'application/vnd.ms-htmlhelp', signatureHex: '49 54 53 46 03 00 00 00', signatureOffset: 0, enableByDefault: true, maxFilesize: 100 * MB },
  { id: 'xps', extension: 'xps', description: 'XML Paper Specification (.xps)', family: 'Documents', mimeType: 'application/vnd.ms-xpsdocument', signatureHex: '50 4B 03 04 (FixedDocument)', signatureOffset: 0, enableByDefault: true, maxFilesize: 100 * MB },
  { id: 'fit', extension: 'fit', description: 'Garmin / ANT+ Fitness Activity (.fit)', family: 'Others', mimeType: 'application/octet-stream', signatureHex: '0E 10 ... 2E 46 49 54', signatureOffset: 0, enableByDefault: true, maxFilesize: 20 * MB },
  { id: 'gpx', extension: 'gpx', description: 'GPS Exchange Route Track (.gpx)', family: 'Documents', mimeType: 'application/gpx+xml', signatureHex: '<gpx ', signatureOffset: 0, enableByDefault: false, maxFilesize: 20 * MB },
  { id: 'kml', extension: 'kml', description: 'Keyhole Markup Geographic Layer (.kml)', family: 'Documents', mimeType: 'application/vnd.google-earth.kml+xml', signatureHex: '<kml ', signatureOffset: 0, enableByDefault: false, maxFilesize: 20 * MB },
  { id: 'dicom', extension: 'dcm', description: 'DICOM Medical Imaging (.dcm)', family: 'Pictures', mimeType: 'application/dicom', signatureHex: '44 49 43 4D', signatureOffset: 128, enableByDefault: true, maxFilesize: 150 * MB },
  { id: 'fits', extension: 'fits', description: 'FITS Astronomical Image (.fits)', family: 'Pictures', mimeType: 'image/fits', signatureHex: '53 49 4D 50 4C 45 20 20 3D', signatureOffset: 0, enableByDefault: false, maxFilesize: 200 * MB },
  { id: 'm4p', extension: 'm4p', description: 'Protected AAC Audio (.m4p)', family: 'Audio', mimeType: 'audio/mp4', signatureHex: '66 74 79 70 4D 34 50 20', signatureOffset: 4, enableByDefault: false, maxFilesize: 50 * MB },
  { id: 'au', extension: 'au', description: 'Sun / NeXT Audio Stream (.au)', family: 'Audio', mimeType: 'audio/basic', signatureHex: '2E 73 6E 64', signatureOffset: 0, enableByDefault: false, maxFilesize: 50 * MB },
  { id: 'ra', extension: 'ra', description: 'RealAudio Stream (.ra)', family: 'Audio', mimeType: 'audio/x-pn-realaudio', signatureHex: '2E 72 61 FD', signatureOffset: 0, enableByDefault: false, maxFilesize: 50 * MB },
  { id: 'nes', extension: 'nes', description: 'Nintendo NES iNES ROM (.nes)', family: 'Others', mimeType: 'application/octet-stream', signatureHex: '4E 45 53 1A', signatureOffset: 0, enableByDefault: false, maxFilesize: 16 * MB },
  { id: 'gba', extension: 'gba', description: 'Game Boy Advance ROM (.gba)', family: 'Others', mimeType: 'application/octet-stream', signatureHex: 'Nintendo Logo @ +4', signatureOffset: 4, enableByDefault: false, maxFilesize: 64 * MB },
  { id: 'pak', extension: 'pak', description: 'Unreal / Quake Game Asset Pack (.pak)', family: 'Archives', mimeType: 'application/octet-stream', signatureHex: '50 41 43 4B', signatureOffset: 0, enableByDefault: false, maxFilesize: 500 * MB },
  { id: 'unity3d', extension: 'unity3d', description: 'Unity Web/Asset Bundle (.unity3d)', family: 'Archives', mimeType: 'application/octet-stream', signatureHex: '55 6E 69 74 79 46 53', signatureOffset: 0, enableByDefault: false, maxFilesize: 500 * MB },
  { id: 'cbor', extension: 'cbor', description: 'Concise Binary Object Snapshot (.cbor)', family: 'Others', mimeType: 'application/cbor', signatureHex: 'D9 D9 F7', signatureOffset: 0, enableByDefault: false, maxFilesize: 50 * MB },
  { id: 'parquet', extension: 'parquet', description: 'Apache Parquet Columnar Data (.parquet)', family: 'Others', mimeType: 'application/vnd.apache.parquet', signatureHex: '50 41 52 31', signatureOffset: 0, enableByDefault: false, maxFilesize: 500 * MB },
  { id: 'hdf5', extension: 'h5', description: 'HDF5 Scientific Dataset (.h5)', family: 'Others', mimeType: 'application/x-hdf5', signatureHex: '89 48 44 46 0D 0A 1A 0A', signatureOffset: 0, enableByDefault: false, maxFilesize: 500 * MB },
  { id: 'mat', extension: 'mat', description: 'MATLAB MAT-File Level 5 (.mat)', family: 'Others', mimeType: 'application/octet-stream', signatureHex: '4D 41 54 4C 41 42 20 35 2E 30', signatureOffset: 0, enableByDefault: false, maxFilesize: 300 * MB },
  { id: 'pyc', extension: 'pyc', description: 'Compiled Python Bytecode (.pyc)', family: 'Others', mimeType: 'application/x-python-code', signatureHex: 'Python 3 Magic + 0D 0A', signatureOffset: 0, enableByDefault: false, maxFilesize: 10 * MB },
  { id: 'der', extension: 'der', description: 'DER Encoded X.509 Certificate (.der)', family: 'Others', mimeType: 'application/x-x509-ca-cert', signatureHex: '30 82 ... 30 82', signatureOffset: 0, enableByDefault: false, maxFilesize: 1 * MB },
  { id: 'kdbx', extension: 'kdbx', description: 'KeePass 2 Password Database (.kdbx)', family: 'Others', mimeType: 'application/x-keepass', signatureHex: '03 D9 A2 9A 67 FB 4B B5', signatureOffset: 0, enableByDefault: true, maxFilesize: 50 * MB },
  { id: 'har', extension: 'har', description: 'HTTP Archive Session Trace (.har)', family: 'Documents', mimeType: 'application/json', signatureHex: '{"log":{"version":', signatureOffset: 0, enableByDefault: false, maxFilesize: 50 * MB },
  { id: 'crx', extension: 'crx', description: 'Chrome / Edge Extension Package (.crx)', family: 'Archives', mimeType: 'application/x-chrome-extension', signatureHex: '43 72 32 34', signatureOffset: 0, enableByDefault: false, maxFilesize: 100 * MB },
  { id: 'xar', extension: 'xar', description: 'Extensible Archive (.xar / .pkg)', family: 'Archives', mimeType: 'application/x-xar', signatureHex: '78 61 72 21 00 1C', signatureOffset: 0, enableByDefault: false, maxFilesize: 300 * MB },
  { id: 'cpio', extension: 'cpio', description: 'POSIX CPIO Archive (.cpio)', family: 'Archives', mimeType: 'application/x-cpio', signatureHex: '30 37 30 37 30 31', signatureOffset: 0, enableByDefault: false, maxFilesize: 200 * MB },
  { id: 'swf_lzma', extension: 'swf', description: 'LZMA Compressed Flash (.swf)', family: 'Videos', mimeType: 'application/x-shockwave-flash', signatureHex: '5A 57 53', signatureOffset: 0, enableByDefault: false, maxFilesize: 100 * MB },
  { id: 'vdi', extension: 'vdi', description: 'VirtualBox Disk Image (.vdi)', family: 'Archives', mimeType: 'application/x-virtualbox-vdi', signatureHex: '<<< Oracle VM VirtualBox Disk Image >>>', signatureOffset: 0, enableByDefault: false, maxFilesize: 500 * MB },
  { id: 'qcow2', extension: 'qcow2', description: 'QEMU Copy-On-Write Disk (.qcow2)', family: 'Archives', mimeType: 'application/x-qemu-disk', signatureHex: '51 46 49 FB', signatureOffset: 0, enableByDefault: false, maxFilesize: 500 * MB },
  { id: 'pcapng_le', extension: 'pcapng', description: 'PCAP-NG Big-Endian Capture (.pcapng)', family: 'Others', mimeType: 'application/x-pcapng', signatureHex: '0A 0D 0D 0A ... 1A 2B 3C 4D', signatureOffset: 0, enableByDefault: false, maxFilesize: 300 * MB },
  { id: 'aep_alt', extension: 'aep', description: 'After Effects CS/CC Binary Project (.aep)', family: 'Others', mimeType: 'application/x-after-effects', signatureHex: '52 49 46 58 ... 45 67 67 21', signatureOffset: 0, enableByDefault: false, maxFilesize: 200 * MB },
  { id: 'ai', extension: 'ai', description: 'Adobe Illustrator Document (.ai)', family: 'Pictures', mimeType: 'application/postscript', signatureHex: '25 50 44 46 (Adobe Illustrator)', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'indd', extension: 'indd', description: 'Adobe InDesign Document (.indd)', family: 'Documents', mimeType: 'application/x-indesign', signatureHex: '06 06 ED F5 D8 1D 46 E5', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'sketch', extension: 'sketch', description: 'Sketch UI Design File (.sketch)', family: 'Pictures', mimeType: 'application/zip', signatureHex: '50 4B 03 04 (document.json)', signatureOffset: 0, enableByDefault: false, maxFilesize: 200 * MB },
  { id: 'fig', extension: 'fig', description: 'Figma Local Design Archive (.fig)', family: 'Pictures', mimeType: 'application/octet-stream', signatureHex: 'fig-kiwi', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'spss', extension: 'sav', description: 'SPSS Statistics Dataset (.sav)', family: 'Others', mimeType: 'application/octet-stream', signatureHex: '24 46 4C 32', signatureOffset: 0, enableByDefault: false, maxFilesize: 200 * MB },
  { id: 'wpd', extension: 'wpd', description: 'WordPerfect Document (.wpd)', family: 'Documents', mimeType: 'application/wordperfect', signatureHex: 'FF 57 50 43', signatureOffset: 0, enableByDefault: false, maxFilesize: 20 * MB },
  { id: 'ac3', extension: 'ac3', description: 'Dolby Digital AC-3 Audio (.ac3)', family: 'Audio', mimeType: 'audio/ac3', signatureHex: '0B 77', signatureOffset: 0, enableByDefault: false, maxFilesize: 100 * MB },
  { id: 'dsf', extension: 'dsf', description: 'Sony DSD Audio (.dsf)', family: 'Audio', mimeType: 'audio/x-dsf', signatureHex: '44 53 44 20', signatureOffset: 0, enableByDefault: false, maxFilesize: 300 * MB },
  { id: 'shn', extension: 'shn', description: 'Shorten Lossless Audio (.shn)', family: 'Audio', mimeType: 'audio/x-shorten', signatureHex: '61 6A 6B 67', signatureOffset: 0, enableByDefault: false, maxFilesize: 200 * MB },
  { id: 'm3u8', extension: 'm3u8', description: 'HLS Media Playlist (.m3u8)', family: 'Documents', mimeType: 'application/vnd.apple.mpegurl', signatureHex: '23 45 58 54 4D 33 55', signatureOffset: 0, enableByDefault: false, maxFilesize: 2 * MB },
  { id: 'srt', extension: 'srt', description: 'SubRip Video Subtitle (.srt)', family: 'Documents', mimeType: 'application/x-subrip', signatureHex: '00:00: --> 00:00:', signatureOffset: 0, enableByDefault: false, maxFilesize: 2 * MB },
  { id: 'vtt', extension: 'vtt', description: 'WebVTT Video Subtitle (.vtt)', family: 'Documents', mimeType: 'text/vtt', signatureHex: '57 45 42 56 54 54', signatureOffset: 0, enableByDefault: false, maxFilesize: 2 * MB },
  { id: 'reg_text', extension: 'reg', description: 'Windows Registry Export Script (.reg)', family: 'Documents', mimeType: 'text/plain', signatureHex: 'Windows Registry Editor Version 5.00', signatureOffset: 0, enableByDefault: false, maxFilesize: 20 * MB },
  { id: 'bat', extension: 'bat', description: 'Windows Batch Script (.bat)', family: 'Documents', mimeType: 'text/plain', signatureHex: '@echo off', signatureOffset: 0, enableByDefault: false, maxFilesize: 1 * MB },
  { id: 'ps1', extension: 'ps1', description: 'PowerShell Script (.ps1)', family: 'Documents', mimeType: 'text/plain', signatureHex: 'PowerShell Script Text', signatureOffset: 0, enableByDefault: false, maxFilesize: 2 * MB },
  { id: 'md', extension: 'md', description: 'Markdown Documentation (.md)', family: 'Documents', mimeType: 'text/markdown', signatureHex: '# Heading / UTF-8 Text', signatureOffset: 0, enableByDefault: false, maxFilesize: 5 * MB },
  { id: 'log', extension: 'log', description: 'Application Diagnostic Log (.log)', family: 'Documents', mimeType: 'text/plain', signatureHex: 'Timestamped UTF-8 Log', signatureOffset: 0, enableByDefault: false, maxFilesize: 20 * MB },
  { id: 'pdb', extension: 'pdb', description: 'Program Debug Symbols (.pdb)', family: 'Others', mimeType: 'application/octet-stream', signatureHex: 'Microsoft C/C++ MSF 7.00', signatureOffset: 0, enableByDefault: false, maxFilesize: 200 * MB },
  { id: 'dmp', extension: 'dmp', description: 'Windows Crash Minidump (.dmp)', family: 'Others', mimeType: 'application/octet-stream', signatureHex: '4D 44 4D 50 93 A7', signatureOffset: 0, enableByDefault: true, maxFilesize: 200 * MB },
  { id: 'etl', extension: 'etl', description: 'Windows Event Trace Log (.etl)', family: 'Others', mimeType: 'application/octet-stream', signatureHex: 'WMI Event Trace', signatureOffset: 0, enableByDefault: false, maxFilesize: 200 * MB },
  { id: 'edb', extension: 'edb', description: 'Windows Search / Exchange ESE Database (.edb)', family: 'Others', mimeType: 'application/octet-stream', signatureHex: 'EF CD AB 89 @ +4', signatureOffset: 4, enableByDefault: false, maxFilesize: 500 * MB },
  { id: 'thumbs', extension: 'db', description: 'Windows Thumbnail Cache (.db / thumbcache)', family: 'Others', mimeType: 'application/octet-stream', signatureHex: '43 4D 4D 4D', signatureOffset: 0, enableByDefault: false, maxFilesize: 100 * MB },
];

const FORMAT_MAP = new Map<string, FileFormatDefinition>(
  FILE_FORMATS.map((f) => [f.id, f]),
);

function readUint16BE(buf: Uint8Array, pos: number): number {
  return ((buf[pos] << 8) | buf[pos + 1]) >>> 0;
}

function readUint16LE(buf: Uint8Array, pos: number): number {
  return (buf[pos] | (buf[pos + 1] << 8)) >>> 0;
}

function readUint32BE(buf: Uint8Array, pos: number): number {
  return (
    ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0
  );
}

function readUint32LE(buf: Uint8Array, pos: number): number {
  return (
    (buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24)) >>> 0
  );
}

function readAscii(buf: Uint8Array, pos: number, len: number): string {
  let out = '';
  const end = Math.min(buf.length, pos + len);
  for (let i = pos; i < end; i++) {
    out += String.fromCharCode(buf[i]);
  }
  return out;
}

function indexOfBytes(
  haystack: Uint8Array,
  needle: number[],
  from: number,
  maxEnd: number,
): number {
  const limit = Math.min(haystack.length, maxEnd) - needle.length;
  for (let i = from; i <= limit; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function validateAndMeasureJpg(
  buf: Uint8Array,
  start: number,
  maxEnd: number,
): { size: number; truncated: boolean; meta: IdentifyMetadata } | null {
  if (start + 4 > maxEnd) return null;
  if (buf[start] !== 0xff || buf[start + 1] !== 0xd8 || buf[start + 2] !== 0xff) return null;
  const m4 = buf[start + 3];
  if (
    m4 !== 0xe0 &&
    m4 !== 0xe1 &&
    m4 !== 0xe2 &&
    m4 !== 0xdb &&
    m4 !== 0xee &&
    m4 !== 0xfe &&
    m4 !== 0xc0 &&
    m4 !== 0xc2
  ) {
    return null;
  }

  let pos = start + 2;
  let width: number | undefined;
  let height: number | undefined;
  let hasDqt = false;
  let hasDht = false;
  let hasSof = false;
  let hasExif = false;
  let sawSos = false;

  const exif = parseExifFromJpeg(buf, start, maxEnd);
  const attachMeta = (baseDetails: string, hasEoi: boolean): IdentifyMetadata => ({
    width,
    height,
    camera: exif?.camera,
    takenAtMs: exif?.takenAtMs,
    jpegValid: { hasDqt, hasDht, hasSof, hasExif, hasEoi },
    details: exif?.camera ? `${baseDetails} · ${exif.camera}` : baseDetails,
  });

  // Digler-inspired JPEG marker walker + bulk_extractor entropy scan (skips embedded EXIF thumbnails cleanly)
  while (pos + 2 <= maxEnd) {
    if (buf[pos] !== 0xff) {
      if (sawSos) {
        // Walk entropy-coded scan stream handling 0xFF 0x00 stuffing & RSTn markers
        let scanPos = pos;
        let foundEoi = -1;
        while (scanPos + 1 < maxEnd) {
          if (buf[scanPos] === 0xff) {
            const nextB = buf[scanPos + 1];
            if (nextB === 0xd9) {
              foundEoi = scanPos;
              break;
            }
            if (nextB === 0x00 || nextB === 0xff || (nextB >= 0xd0 && nextB <= 0xd7)) {
              scanPos += nextB === 0xff ? 1 : 2;
              continue;
            }
          }
          scanPos++;
        }
        if (foundEoi !== -1) {
          const dimText = width && height ? `${width}x${height} px` : 'JFIF/Exif stream';
          return {
            size: foundEoi + 2 - start,
            truncated: false,
            meta: attachMeta(dimText, true),
          };
        }
        return {
          size: Math.min(maxEnd - start, 2 * MB),
          truncated: true,
          meta: attachMeta('Missing FFD9 EOI', false),
        };
      }
      return null;
    }

    while (pos < maxEnd && buf[pos] === 0xff) pos++;
    if (pos >= maxEnd) break;
    const marker = buf[pos];
    pos++;

    if (marker === 0xd9) {
      const dimText = width && height ? `${width}x${height} px` : 'JPEG';
      return {
        size: pos - start,
        truncated: false,
        meta: attachMeta(dimText, true),
      };
    }
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd8)) {
      continue;
    }
    if (pos + 2 > maxEnd) break;
    const segLen = readUint16BE(buf, pos);
    if (segLen < 2 || pos + segLen > maxEnd) {
      if (sawSos) break;
      return null;
    }

    if (marker === 0xdb) hasDqt = true;
    if (marker === 0xc4) hasDht = true;
    if (marker === 0xe1) hasExif = true;
    if ((marker === 0xc0 || marker === 0xc1 || marker === 0xc2) && segLen >= 7 && pos + 7 <= maxEnd) {
      hasSof = true;
      height = readUint16BE(buf, pos + 3);
      width = readUint16BE(buf, pos + 5);
    }
    if (marker === 0xda) {
      sawSos = true;
    }

    pos += segLen;
  }

  if (sawSos) {
    return {
      size: Math.min(maxEnd - start, 2 * MB),
      truncated: true,
      meta: attachMeta('Truncated JPEG stream', false),
    };
  }
  return null;
}

function validateAndMeasurePng(
  buf: Uint8Array,
  start: number,
  maxEnd: number,
): { size: number; truncated: boolean; meta: IdentifyMetadata } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (start + 33 > maxEnd) return null;
  for (let i = 0; i < 8; i++) {
    if (buf[start + i] !== sig[i]) return null;
  }

  // Validate IHDR (from file_png.c: png_check_ihdr)
  const ihdrLen = readUint32BE(buf, start + 8);
  const ihdrType = readAscii(buf, start + 12, 4);
  if (ihdrType !== 'IHDR' || ihdrLen !== 13) return null;
  const width = readUint32BE(buf, start + 16);
  const height = readUint32BE(buf, start + 20);
  const bitDepth = buf[start + 24];
  const colorType = buf[start + 25];
  if (width === 0 || height === 0 || width > 65535 || height > 65535) return null;
  if (![0, 2, 3, 4, 6].includes(colorType)) return null;
  if (![1, 2, 4, 8, 16].includes(bitDepth)) return null;

  let pos = start + 8;
  while (pos + 12 <= maxEnd) {
    const chunkLen = readUint32BE(buf, pos);
    const chunkType = readAscii(buf, pos + 4, 4);
    if (chunkLen > 32 * MB) return null;
    const nextPos = pos + 12 + chunkLen;
    if (nextPos > maxEnd) {
      return {
        size: maxEnd - start,
        truncated: true,
        meta: { width, height, details: `${width}x${height} px · truncated` },
      };
    }
    pos = nextPos;
    if (chunkType === 'IEND') {
      return {
        size: pos - start,
        truncated: false,
        meta: { width, height, details: `${width}x${height} px · ${bitDepth}-bit` },
      };
    }
  }
  return null;
}

function validateAndMeasureGif(
  buf: Uint8Array,
  start: number,
  maxEnd: number,
): { size: number; truncated: boolean; meta: IdentifyMetadata } | null {
  if (start + 13 > maxEnd) return null;
  const hdr = readAscii(buf, start, 6);
  if (hdr !== 'GIF87a' && hdr !== 'GIF89a') return null;
  const width = readUint16LE(buf, start + 6);
  const height = readUint16LE(buf, start + 8);
  if (width === 0 || height === 0) return null;

  const packed = buf[start + 10];
  let pos = start + 13;
  if ((packed & 0x80) !== 0) {
    const gctSize = 3 * (1 << ((packed & 0x07) + 1));
    pos += gctSize;
  }

  while (pos < maxEnd) {
    const blockId = buf[pos];
    if (blockId === 0x3b) {
      return {
        size: pos + 1 - start,
        truncated: false,
        meta: { width, height, details: `${hdr} · ${width}x${height} px` },
      };
    }
    if (blockId === 0x2c) {
      // Image descriptor
      if (pos + 10 > maxEnd) break;
      const lPacked = buf[pos + 9];
      pos += 10;
      if ((lPacked & 0x80) !== 0) {
        pos += 3 * (1 << ((lPacked & 0x07) + 1));
      }
      if (pos >= maxEnd) break;
      pos += 1; // LZW minimum code size
      while (pos < maxEnd) {
        const subLen = buf[pos];
        pos += 1;
        if (subLen === 0) break;
        pos += subLen;
      }
    } else if (blockId === 0x21) {
      // Extension block
      if (pos + 2 > maxEnd) break;
      pos += 2;
      while (pos < maxEnd) {
        const subLen = buf[pos];
        pos += 1;
        if (subLen === 0) break;
        pos += subLen;
      }
    } else {
      break;
    }
  }
  return {
    size: Math.min(maxEnd - start, 64 * 1024),
    truncated: true,
    meta: { width, height, details: `${hdr} · ${width}x${height} px` },
  };
}

function validateAndMeasurePdf(
  buf: Uint8Array,
  start: number,
  maxEnd: number,
): { size: number; truncated: boolean; meta: IdentifyMetadata } | null {
  if (start + 8 > maxEnd) return null;
  const sig = readAscii(buf, start, 7);
  if (!sig.startsWith('%PDF-1.') && !sig.startsWith('%PDF-2.')) return null;
  const version = readAscii(buf, start + 5, 3);
  const eofMarker = [0x25, 0x25, 0x45, 0x4f, 0x46]; // %%EOF
  const searchLimit = Math.min(maxEnd, start + 10 * MB);
  let lastEof = -1;
  let scan = start + 8;
  while (scan < searchLimit) {
    const idx = indexOfBytes(buf, eofMarker, scan, searchLimit);
    if (idx === -1) break;
    lastEof = idx;
    // Check if another %PDF- starts before we keep scanning
    const nextPdf = indexOfBytes(buf, [0x25, 0x50, 0x44, 0x46, 0x2d], idx + 5, searchLimit);
    if (nextPdf !== -1) {
      // Stop before the next PDF file
      break;
    }
    scan = idx + 5;
  }

  // Optional /Title extraction (like file_rename_pdf in file_pdf.c)
  let title: string | undefined;
  const titleIdx = indexOfBytes(buf, [0x2f, 0x54, 0x69, 0x74, 0x6c, 0x65], start, Math.min(maxEnd, start + 65536));
  if (titleIdx !== -1) {
    const openParen = indexOfBytes(buf, [0x28], titleIdx, Math.min(maxEnd, titleIdx + 32));
    if (openParen !== -1) {
      const closeParen = indexOfBytes(buf, [0x29], openParen + 1, Math.min(maxEnd, openParen + 128));
      if (closeParen !== -1) {
        const rawTitle = readAscii(buf, openParen + 1, closeParen - openParen - 1).replace(/[^\x20-\x7e]/g, '').trim();
        if (rawTitle.length > 0) title = rawTitle;
      }
    }
  }

  if (lastEof !== -1) {
    let end = lastEof + 5;
    if (end < maxEnd && buf[end] === 0x0d) end++;
    if (end < maxEnd && buf[end] === 0x0a) end++;
    return {
      size: end - start,
      truncated: false,
      meta: {
        details: title ? `PDF ${version} · "${title}"` : `PDF ${version}`,
      },
    };
  }
  return null;
}

function validateAndMeasureZip(
  buf: Uint8Array,
  start: number,
  maxEnd: number,
): { size: number; truncated: boolean; meta: IdentifyMetadata } | null {
  if (start + 30 > maxEnd) return null;
  if (buf[start] !== 0x50 || buf[start + 1] !== 0x4b || buf[start + 2] !== 0x03 || buf[start + 3] !== 0x04) {
    return null;
  }

  const compression = readUint16LE(buf, start + 8);
  const fnameLen = readUint16LE(buf, start + 26);
  const extraLen = readUint16LE(buf, start + 28);
  if (fnameLen === 0 || fnameLen > 512 || compression > 99) return null;
  if (start + 30 + fnameLen > maxEnd) return null;

  const firstFilename = readAscii(buf, start + 30, fnameLen);
  let subExtension = 'zip';
  if (firstFilename.startsWith('word/')) subExtension = 'docx';
  else if (firstFilename.startsWith('xl/')) subExtension = 'xlsx';
  else if (firstFilename.startsWith('ppt/')) subExtension = 'pptx';
  else if (firstFilename === 'mimetype') {
    const mimeContent = readAscii(buf, start + 30 + fnameLen + extraLen, 64);
    if (mimeContent.includes('opendocument.text')) subExtension = 'odt';
    else if (mimeContent.includes('opendocument.spreadsheet')) subExtension = 'ods';
    else if (mimeContent.includes('opendocument.presentation')) subExtension = 'odp';
    else if (mimeContent.includes('epub+zip')) subExtension = 'epub';
    else if (mimeContent.includes('x-krita')) subExtension = 'kra';
    else if (mimeContent.includes('openraster')) subExtension = 'ora';
  } else if (firstFilename.includes('AndroidManifest.xml')) subExtension = 'apk';
  else if (firstFilename.includes('META-INF/')) subExtension = 'jar';
  else if (firstFilename.endsWith('.kml')) subExtension = 'kmz';
  else if (firstFilename.includes('FixedDocument') || firstFilename.includes('FixedDocSeq')) subExtension = 'xps';
  else if (firstFilename === 'document.json') subExtension = 'sketch';

  const detectFromSliceStr = (sliceStr: string) => {
    if (subExtension !== 'zip') return;
    if (sliceStr.includes('word/')) subExtension = 'docx';
    else if (sliceStr.includes('xl/')) subExtension = 'xlsx';
    else if (sliceStr.includes('ppt/')) subExtension = 'pptx';
    else if (sliceStr.includes('AndroidManifest.xml')) subExtension = 'apk';
    else if (sliceStr.includes('FixedDocument')) subExtension = 'xps';
    else if (sliceStr.includes('doc.kml')) subExtension = 'kmz';
    else if (sliceStr.includes('META-INF/')) subExtension = 'jar';
  };

  // Scan forward for EOCD (PK\x05\x06) and also inspect entries along the way
  const searchLimit = Math.min(maxEnd, start + 32 * MB);
  const eocdSig = [0x50, 0x4b, 0x05, 0x06];
  const eocdPos = indexOfBytes(buf, eocdSig, start + 30, searchLimit);
  detectFromSliceStr(readAscii(buf, start, Math.min(searchLimit - start, 16384)));
  if (eocdPos !== -1 && eocdPos + 22 <= maxEnd) {
    const commentLen = readUint16LE(buf, eocdPos + 20);
    const totalSize = Math.min(maxEnd - start, eocdPos + 22 + commentLen - start);
    if (subExtension === 'zip') {
      detectFromSliceStr(readAscii(buf, Math.max(start, eocdPos - 8192), Math.min(totalSize, 8192)));
    }
    return {
      size: totalSize,
      truncated: false,
      meta: {
        subExtension,
        details: `${subExtension.toUpperCase()} · first entry "${firstFilename}"`,
      },
    };
  }

  // Salvage truncated ZIP stream lacking EOCD up to next foreign signature or bounded limit
  const fallbackEnd = Math.min(maxEnd - start, 4 * MB);
  if (fallbackEnd >= 32) {
    return {
      size: fallbackEnd,
      truncated: true,
      meta: {
        subExtension,
        details: `${subExtension.toUpperCase()} · truncated (missing Central Directory EOCD)`,
      },
    };
  }
  return null;
}

function validateAndMeasureMp4(
  buf: Uint8Array,
  start: number,
  maxEnd: number,
): { size: number; truncated: boolean; meta: IdentifyMetadata } | null {
  if (start + 12 > maxEnd) return null;
  if (readAscii(buf, start + 4, 4) !== 'ftyp') return null;
  const firstSize = readUint32BE(buf, start);
  if (firstSize < 16 || firstSize > 1024) return null;
  const brand = readAscii(buf, start + 8, 4).trim();
  const validBrands = [
    'isom',
    'iso2',
    'mp41',
    'mp42',
    'M4V',
    'M4A',
    'M4B',
    'M4P',
    'qt',
    'avc1',
    '3gp4',
    '3gp5',
    '3gp6',
    '3g2a',
    'heic',
    'heix',
    'mif1',
    'avif',
    'avis',
    'braw',
    'crx',
    'XAVC',
  ];
  if (!validBrands.some((b) => brand.startsWith(b)) && !/^[a-zA-Z0-9]{3,4}$/.test(brand)) {
    return null;
  }

  const mapBrandToExt = (b: string): string => {
    const low = b.toLowerCase();
    if (low === 'qt') return 'mov';
    if (low === 'heic' || low === 'heix' || low === 'mif1') return 'heic';
    if (low === 'avif' || low === 'avis') return 'avif';
    if (low === 'm4a') return 'm4a';
    if (low === 'm4b') return 'm4b';
    if (low === 'm4v') return 'm4v';
    if (low.startsWith('3gp')) return '3gp';
    if (low.startsWith('3g2')) return '3g2';
    if (low === 'crx') return 'cr3';
    if (low === 'braw') return 'braw';
    return 'mp4';
  };
  const subExt = mapBrandToExt(brand);

  let pos = start;
  const boxNames: string[] = [];
  let hasMoov = false;
  let hasMdat = false;

  while (pos + 8 <= maxEnd && boxNames.length < 128) {
    let boxSize = readUint32BE(buf, pos);
    const boxType = readAscii(buf, pos + 4, 4);
    if (boxSize === 1 && pos + 16 <= maxEnd) {
      boxSize = readUint32BE(buf, pos + 8) * 4294967296 + readUint32BE(buf, pos + 12);
    } else if (boxSize === 0) {
      boxSize = maxEnd - pos;
    }
    if (boxSize < 8 || !/^[\x20-\x7e]{4}$/.test(boxType)) break;
    boxNames.push(boxType);
    if (boxType === 'moov') hasMoov = true;
    if (boxType === 'mdat') hasMdat = true;
    if (pos + boxSize > maxEnd) {
      return {
        size: maxEnd - start,
        truncated: true,
        meta: {
          subExtension: subExt,
          details: `ISO BMFF (${brand}) · boxes: ${boxNames.join(', ')}${!hasMoov && hasMdat ? ' (moov pending/at EOF)' : ''}`,
        },
      };
    }
    pos += boxSize;
  }

  if (pos > start + firstSize || boxNames.length >= 1) {
    const missingIndex = (hasMdat && !hasMoov) || (!hasMdat && boxNames.length === 1 && subExt !== 'heic' && subExt !== 'avif');
    return {
      size: pos - start,
      truncated: missingIndex,
      meta: {
        subExtension: subExt,
        details: missingIndex
          ? `ISO BMFF (${brand}) · ${boxNames.join(' → ')} (${hasMdat ? 'missing moov index atom' : 'missing mdat payload'})`
          : `ISO BMFF (${brand}) · ${boxNames.join(' → ')}`,
      },
    };
  }
  return null;
}

export function identifyBuffer(
  buf: Uint8Array,
  enabledFormats?: Set<string>,
): IdentifyResult | null {
  const isEnabled = (id: string) => !enabledFormats || enabledFormats.has(id);

  // 1. PNG
  if (isEnabled('png')) {
    const png = validateAndMeasurePng(buf, 0, buf.length);
    if (png) {
      const def = FORMAT_MAP.get('png')!;
      return {
        formatId: 'png',
        extension: 'png',
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 8,
        calculatedSize: png.size,
        status: png.truncated ? 'OK_TRUNCATED' : 'OK',
        metadata: png.meta,
      };
    }
  }

  // 2. JPG
  if (isEnabled('jpg')) {
    const jpg = validateAndMeasureJpg(buf, 0, buf.length);
    if (jpg) {
      const def = FORMAT_MAP.get('jpg')!;
      return {
        formatId: 'jpg',
        extension: 'jpg',
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 3,
        calculatedSize: jpg.size,
        status: jpg.truncated ? 'OK_TRUNCATED' : 'OK',
        metadata: jpg.meta,
      };
    }
  }

  // 3. GIF
  if (isEnabled('gif')) {
    const gif = validateAndMeasureGif(buf, 0, buf.length);
    if (gif) {
      const def = FORMAT_MAP.get('gif')!;
      return {
        formatId: 'gif',
        extension: 'gif',
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 6,
        calculatedSize: gif.size,
        status: gif.truncated ? 'OK_TRUNCATED' : 'OK',
        metadata: gif.meta,
      };
    }
  }

  // 4. BMP
  if (isEnabled('bmp') && buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    const bfSize = readUint32LE(buf, 2);
    const dibSize = readUint32LE(buf, 14);
    if ([12, 40, 52, 56, 108, 124].includes(dibSize) && bfSize >= 26 && bfSize < 100 * MB) {
      const w = dibSize >= 40 ? readUint32LE(buf, 18) : readUint16LE(buf, 18);
      const h = dibSize >= 40 ? readUint32LE(buf, 22) : readUint16LE(buf, 20);
      const def = FORMAT_MAP.get('bmp')!;
      return {
        formatId: 'bmp',
        extension: 'bmp',
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 2,
        calculatedSize: bfSize,
        status: bfSize <= buf.length ? 'OK' : 'OK_TRUNCATED',
        metadata: { width: w, height: h, details: `${w}x${h} px · DIB ${dibSize}B` },
      };
    }
  }

  // 5. RIFF (WEBP / WAV / AVI / CDR / ANI) & RIFX (Adobe After Effects .aep)
  if (buf.length >= 12) {
    const riffMagic = readAscii(buf, 0, 4);
    if (riffMagic === 'RIFF') {
      const riffSize = readUint32LE(buf, 4) + 8;
      const fourcc = readAscii(buf, 8, 4);
      if (fourcc === 'WEBP' && isEnabled('webp')) {
        const def = FORMAT_MAP.get('webp')!;
        return {
          formatId: 'webp',
          extension: 'webp',
          description: def.description,
          family: def.family,
          mimeType: def.mimeType,
          matchedOffset: 0,
          matchedLength: 12,
          calculatedSize: riffSize,
          status: riffSize <= buf.length ? 'OK' : 'OK_TRUNCATED',
          metadata: { details: 'RIFF WebP image' },
        };
      }
      if (fourcc === 'WAVE' && isEnabled('wav')) {
        const def = FORMAT_MAP.get('wav')!;
        return {
          formatId: 'wav',
          extension: 'wav',
          description: def.description,
          family: def.family,
          mimeType: def.mimeType,
          matchedOffset: 0,
          matchedLength: 12,
          calculatedSize: riffSize,
          status: riffSize <= buf.length ? 'OK' : 'OK_TRUNCATED',
          metadata: { details: 'RIFF PCM Audio' },
        };
      }
      if (fourcc === 'AVI ' && isEnabled('avi')) {
        const def = FORMAT_MAP.get('avi')!;
        return {
          formatId: 'avi',
          extension: 'avi',
          description: def.description,
          family: def.family,
          mimeType: def.mimeType,
          matchedOffset: 0,
          matchedLength: 12,
          calculatedSize: riffSize,
          status: riffSize <= buf.length ? 'OK' : 'OK_TRUNCATED',
          metadata: { details: 'RIFF AVI Video' },
        };
      }
      if (fourcc.startsWith('CDR') && isEnabled('cdr')) {
        const def = FORMAT_MAP.get('cdr')!;
        return {
          formatId: 'cdr',
          extension: 'cdr',
          description: def.description,
          family: def.family,
          mimeType: def.mimeType,
          matchedOffset: 0,
          matchedLength: 12,
          calculatedSize: riffSize,
          status: riffSize <= buf.length ? 'OK' : 'OK_TRUNCATED',
          metadata: { details: `CorelDRAW (${fourcc})` },
        };
      }
      if (fourcc === 'ACON' && isEnabled('ani')) {
        const def = FORMAT_MAP.get('ani')!;
        return {
          formatId: 'ani',
          extension: 'ani',
          description: def.description,
          family: def.family,
          mimeType: def.mimeType,
          matchedOffset: 0,
          matchedLength: 12,
          calculatedSize: riffSize,
          status: riffSize <= buf.length ? 'OK' : 'OK_TRUNCATED',
          metadata: { details: 'Windows Animated Cursor' },
        };
      }
    } else if (riffMagic === 'RIFX') {
      const rifxSize = readUint32BE(buf, 4) + 8;
      const fourcc = readAscii(buf, 8, 4);
      if (fourcc === 'Egg!' && isEnabled('aep')) {
        const def = FORMAT_MAP.get('aep')!;
        return {
          formatId: 'aep',
          extension: 'aep',
          description: def.description,
          family: def.family,
          mimeType: def.mimeType,
          matchedOffset: 0,
          matchedLength: 12,
          calculatedSize: rifxSize,
          status: rifxSize <= buf.length ? 'OK' : 'OK_TRUNCATED',
          metadata: { details: 'Adobe After Effects Binary Project (RIFX Egg!)' },
        };
      }
    } else if (riffMagic === 'FORM' && readAscii(buf, 8, 4) === 'AIFF' && isEnabled('aiff')) {
      const formSize = readUint32BE(buf, 4) + 8;
      const def = FORMAT_MAP.get('aiff')!;
      return {
        formatId: 'aiff',
        extension: 'aiff',
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 12,
        calculatedSize: formSize,
        status: formSize <= buf.length ? 'OK' : 'OK_TRUNCATED',
        metadata: { details: 'Apple AIFF Uncompressed Audio' },
      };
    }
  }

  // 5b. Fujifilm RAF Camera RAW
  if (isEnabled('raf') && buf.length >= 64 && readAscii(buf, 0, 15) === 'FUJIFILMCCD-RAW') {
    const def = FORMAT_MAP.get('raf')!;
    const model = readAscii(buf, 28, 32).replace(/\0.*$/, '').trim();
    return {
      formatId: 'raf',
      extension: 'raf',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 15,
      calculatedSize: buf.length,
      status: 'HEADER_ONLY',
      metadata: {
        camera: model || 'Fujifilm',
        details: model ? `Fujifilm RAW · ${model}` : 'Fujifilm CCD-RAW container',
      },
    };
  }

  // 5c. Olympus ORF & Panasonic RW2 Camera RAW
  if (
    isEnabled('orf') &&
    buf.length >= 16 &&
    ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x52 && buf[3] === 0x4f) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x4f && buf[3] === 0x52))
  ) {
    const def = FORMAT_MAP.get('orf')!;
    return {
      formatId: 'orf',
      extension: 'orf',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 4,
      calculatedSize: buf.length,
      status: 'HEADER_ONLY',
      metadata: { camera: 'Olympus', details: 'Olympus RAW (IIRO/MMOR)' },
    };
  }

  if (
    isEnabled('rw2') &&
    buf.length >= 16 &&
    buf[0] === 0x49 &&
    buf[1] === 0x49 &&
    buf[2] === 0x55 &&
    buf[3] === 0x00
  ) {
    const def = FORMAT_MAP.get('rw2')!;
    return {
      formatId: 'rw2',
      extension: 'rw2',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 4,
      calculatedSize: buf.length,
      status: 'HEADER_ONLY',
      metadata: { camera: 'Panasonic Lumix', details: 'Panasonic RAW (IIU\\0)' },
    };
  }

  // 5d. Canon CR3 Camera RAW (ISO BMFF ftypcrx )
  if (
    isEnabled('cr3') &&
    buf.length >= 16 &&
    readAscii(buf, 4, 8) === 'ftypcrx '
  ) {
    const def = FORMAT_MAP.get('cr3')!;
    const mp4 = validateAndMeasureMp4(buf, 0, buf.length);
    return {
      formatId: 'cr3',
      extension: 'cr3',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 4,
      matchedLength: 8,
      calculatedSize: mp4?.size ?? buf.length,
      status: mp4 ? (mp4.truncated ? 'OK_TRUNCATED' : 'OK') : 'HEADER_ONLY',
      metadata: {
        camera: 'Canon',
        details: 'Canon CR3 ISO BMFF RAW',
      },
    };
  }

  // 6. TIFF & TIFF-derived Camera RAW (CR2 / DNG / NEF / ARW via IFD0 inspection)
  if (
    buf.length >= 16 &&
    ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a))
  ) {
    const isLe = buf[0] === 0x49;
    const u16 = (p: number) => (isLe ? readUint16LE(buf, p) : readUint16BE(buf, p));
    const u32 = (p: number) => (isLe ? readUint32LE(buf, p) : readUint32BE(buf, p));

    // Canon CR2 signature: byte 8..11 === 'CR\x02\x00'
    if (
      isEnabled('cr2') &&
      buf[8] === 0x43 &&
      buf[9] === 0x52 &&
      buf[10] === 0x02 &&
      buf[11] === 0x00
    ) {
      const def = FORMAT_MAP.get('cr2')!;
      return {
        formatId: 'cr2',
        extension: 'cr2',
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 10,
        calculatedSize: buf.length,
        status: 'HEADER_ONLY',
        metadata: { camera: 'Canon', details: 'Canon CR2 Camera RAW' },
      };
    }

    // Parse IFD0 tags for DNGVersion (0xC612) or Camera Make (0x010F -> NIKON / SONY)
    const ifdOff = u32(4);
    let rawId: 'dng' | 'nef' | 'arw' | null = null;
    let cameraMake = '';
    if (ifdOff >= 8 && ifdOff + 2 <= buf.length) {
      const count = Math.min(64, u16(ifdOff));
      for (let i = 0; i < count; i++) {
        const eOff = ifdOff + 2 + i * 12;
        if (eOff + 12 > buf.length) break;
        const tag = u16(eOff);
        if (tag === 0xc612) {
          rawId = 'dng';
        } else if (tag === 0x010f) {
          const valCount = u32(eOff + 4);
          const valOff = valCount <= 4 ? eOff + 8 : u32(eOff + 8);
          if (valOff + Math.min(32, valCount) <= buf.length) {
            cameraMake = readAscii(buf, valOff, Math.min(32, valCount))
              .replace(/\0.*$/, '')
              .trim();
          }
        }
      }
      if (!rawId && cameraMake) {
        const up = cameraMake.toUpperCase();
        if (up.includes('NIKON')) rawId = 'nef';
        else if (up.includes('SONY')) rawId = 'arw';
      }
    }

    if (rawId && isEnabled(rawId)) {
      const def = FORMAT_MAP.get(rawId)!;
      return {
        formatId: rawId,
        extension: rawId,
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 4,
        calculatedSize: buf.length,
        status: 'HEADER_ONLY',
        metadata: {
          camera: cameraMake || rawId.toUpperCase(),
          details: `${def.description}${cameraMake ? ` · ${cameraMake}` : ''}`,
        },
      };
    }

    if (isEnabled('tiff')) {
      const def = FORMAT_MAP.get('tiff')!;
      const endian = isLe ? 'Little-Endian (II)' : 'Big-Endian (MM)';
      return {
        formatId: 'tiff',
        extension: 'tif',
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 4,
        calculatedSize: buf.length,
        status: 'HEADER_ONLY',
        metadata: { details: `TIFF ${endian}` },
      };
    }
  }

  // 7. PDF (and Adobe Illustrator PDF-backed .ai)
  if (isEnabled('pdf') || isEnabled('ai')) {
    const pdf = validateAndMeasurePdf(buf, 0, buf.length);
    if (pdf) {
      const headProbe = readAscii(buf, 0, Math.min(buf.length, 4096));
      const isAi = isEnabled('ai') && /Adobe Illustrator|AIPrivateData/i.test(headProbe);
      const id = isAi ? 'ai' : 'pdf';
      const def = FORMAT_MAP.get(id)!;
      return {
        formatId: id,
        extension: id,
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 7,
        calculatedSize: pdf.size,
        status: pdf.truncated ? 'OK_TRUNCATED' : 'OK',
        metadata: pdf.meta,
      };
    }
  }

  // 8. ZIP & Smart OOXML / ODF / EPUB / APK / JAR / KRA / ORA Sub-typing
  if (
    isEnabled('zip') ||
    isEnabled('docx') ||
    isEnabled('xlsx') ||
    isEnabled('pptx') ||
    isEnabled('odt') ||
    isEnabled('ods') ||
    isEnabled('odp') ||
    isEnabled('epub') ||
    isEnabled('apk') ||
    isEnabled('jar') ||
    isEnabled('kra') ||
    isEnabled('ora') ||
    isEnabled('kmz') ||
    isEnabled('sketch') ||
    isEnabled('xps')
  ) {
    const zip = validateAndMeasureZip(buf, 0, buf.length);
    if (zip) {
      const subExt = zip.meta.subExtension ?? 'zip';
      const subDef = FORMAT_MAP.get(subExt) ?? FORMAT_MAP.get('zip')!;
      if (isEnabled(subDef.id) || isEnabled('zip')) {
        return {
          formatId: subDef.id,
          extension: subExt,
          description: subDef.description,
          family: subDef.family,
          mimeType: subDef.mimeType,
          matchedOffset: 0,
          matchedLength: 4,
          calculatedSize: zip.size,
          status: zip.truncated ? 'OK_TRUNCATED' : 'OK',
          metadata: zip.meta,
        };
      }
    }
  }

  // 8b. Microsoft OLE2 Compound Binary (DOC / XLS / PPT / MSG / PUB / MSI)
  if (
    buf.length >= 512 &&
    buf[0] === 0xd0 &&
    buf[1] === 0xcf &&
    buf[2] === 0x11 &&
    buf[3] === 0xe0 &&
    buf[4] === 0xa1 &&
    buf[5] === 0xb1 &&
    buf[6] === 0x1a &&
    buf[7] === 0xe1
  ) {
    // Inspect UTF-16LE directory entry names inside first 64 KiB
    const sample = buf.subarray(0, Math.min(buf.length, 65536));
    let u16Ascii = '';
    for (let i = 512; i + 1 < sample.length; i += 2) {
      if (sample[i + 1] === 0 && sample[i] >= 32 && sample[i] <= 126) {
        u16Ascii += String.fromCharCode(sample[i]);
      }
    }
    let oleId = 'doc';
    if (u16Ascii.includes('__substg1.0') || u16Ascii.includes('__properties_version1.0')) oleId = 'msg';
    else if (u16Ascii.includes('Workbook') || u16Ascii.includes('Book')) oleId = 'xls';
    else if (u16Ascii.includes('PowerPoint Document')) oleId = 'ppt';
    else if (u16Ascii.includes('Quill')) oleId = 'pub';
    else if (u16Ascii.includes('_SummaryInformation') && u16Ascii.includes('Msi')) oleId = 'msi';
    else if (u16Ascii.includes('Catalog') && buf.length < 4 * MB) oleId = 'db';
    else if (u16Ascii.includes('WordDocument')) oleId = 'doc';

    if (isEnabled(oleId) || isEnabled('doc')) {
      const def = FORMAT_MAP.get(oleId) ?? FORMAT_MAP.get('doc')!;
      return {
        formatId: def.id,
        extension: def.extension,
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 8,
        calculatedSize: buf.length,
        sizeEstimated: true,
        status: 'HEADER_ONLY',
        metadata: { subExtension: def.extension, details: `OLE2 Compound (${def.extension.toUpperCase()})` },
      };
    }
  }

  // 9. 7z
  if (
    isEnabled('7z') &&
    buf.length >= 32 &&
    buf[0] === 0x37 &&
    buf[1] === 0x7a &&
    buf[2] === 0xbc &&
    buf[3] === 0xaf &&
    buf[4] === 0x27 &&
    buf[5] === 0x1c
  ) {
    const nextOffset = readUint32LE(buf, 12);
    const nextSize = readUint32LE(buf, 20);
    const calc = 32 + nextOffset + nextSize;
    const def = FORMAT_MAP.get('7z')!;
    return {
      formatId: '7z',
      extension: '7z',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 6,
      calculatedSize: calc,
      status: calc <= buf.length ? 'OK' : 'OK_TRUNCATED',
      metadata: { details: `7z v${buf[6]}.${buf[7]} · NextHeader @ +${32 + nextOffset}` },
    };
  }

  // 10. GZ
  if (isEnabled('gz') && buf.length >= 10 && buf[0] === 0x1f && buf[1] === 0x8b && buf[2] === 0x08) {
    const def = FORMAT_MAP.get('gz')!;
    return {
      formatId: 'gz',
      extension: 'gz',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 3,
      calculatedSize: buf.length,
      sizeEstimated: true,
      status: 'HEADER_ONLY',
      metadata: { details: `Deflate stream (FLG=0x${buf[3].toString(16).padStart(2, '0')})` },
    };
  }

  // 11. RAR
  if (
    isEnabled('rar') &&
    buf.length >= 7 &&
    buf[0] === 0x52 &&
    buf[1] === 0x61 &&
    buf[2] === 0x72 &&
    buf[3] === 0x21 &&
    buf[4] === 0x1a &&
    buf[5] === 0x07
  ) {
    const def = FORMAT_MAP.get('rar')!;
    return {
      formatId: 'rar',
      extension: 'rar',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 6,
      calculatedSize: buf.length,
      sizeEstimated: true,
      status: 'HEADER_ONLY',
      metadata: { details: buf[6] === 0x01 ? 'RAR5 format' : 'RAR4 format' },
    };
  }

  // 12. SQLite 3
  if (isEnabled('sqlite') && buf.length >= 100 && readAscii(buf, 0, 15) === 'SQLite format 3' && buf[15] === 0) {
    let pageSize = readUint16BE(buf, 16);
    if (pageSize === 1) pageSize = 65536;
    const pageCount = readUint32BE(buf, 28);
    const calc = pageSize * pageCount;
    const def = FORMAT_MAP.get('sqlite')!;
    return {
      formatId: 'sqlite',
      extension: 'sqlite',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 16,
      calculatedSize: calc > 0 ? calc : buf.length,
      sizeEstimated: calc <= 0,
      status: calc > 0 && calc <= buf.length ? 'OK' : calc > buf.length ? 'OK_TRUNCATED' : 'HEADER_ONLY',
      metadata: { details: `Page size ${pageSize} B · ${pageCount} pages` },
    };
  }

  // 12b. Windows Icon (.ico) / Cursor (.cur)
  if (
    (isEnabled('ico') || isEnabled('cur')) &&
    buf.length >= 22 &&
    buf[0] === 0x00 &&
    buf[1] === 0x00 &&
    (buf[2] === 0x01 || buf[2] === 0x02) &&
    buf[3] === 0x00
  ) {
    const count = readUint16LE(buf, 4);
    if (count >= 1 && count <= 32 && buf.length >= 6 + count * 16) {
      let maxEnd = 6 + count * 16;
      let validDir = true;
      for (let i = 0; i < count; i++) {
        const entryOff = 6 + i * 16;
        const dataSz = readUint32LE(buf, entryOff + 8);
        const imgOff = readUint32LE(buf, entryOff + 12);
        if (dataSz === 0 || imgOff < 6 + count * 16 || dataSz > 2 * MB) {
          validDir = false;
          break;
        }
        maxEnd = Math.max(maxEnd, imgOff + dataSz);
      }
      if (validDir && maxEnd > 22) {
        const isCur = buf[2] === 0x02;
        const id = isCur ? 'cur' : 'ico';
        if (isEnabled(id)) {
          const def = FORMAT_MAP.get(id)!;
          return {
            formatId: id,
            extension: id,
            description: def.description,
            family: def.family,
            mimeType: def.mimeType,
            matchedOffset: 0,
            matchedLength: 4,
            calculatedSize: Math.min(maxEnd, buf.length),
            status: maxEnd <= buf.length ? 'OK' : 'OK_TRUNCATED',
            metadata: { details: `${count} embedded ${isCur ? 'cursor' : 'icon'} frame${count === 1 ? '' : 's'}` },
          };
        }
      }
    }
  }

  // 13. MP4 / MOV / HEIC / AVIF / M4A / M4V / 3GP / BRAW
  if (
    isEnabled('mp4') ||
    isEnabled('mov') ||
    isEnabled('heic') ||
    isEnabled('avif') ||
    isEnabled('m4a') ||
    isEnabled('m4v') ||
    isEnabled('3gp') ||
    isEnabled('3g2') ||
    isEnabled('braw') ||
    isEnabled('cr3')
  ) {
    const mp4 = validateAndMeasureMp4(buf, 0, buf.length);
    if (mp4) {
      const sub = mp4.meta.subExtension ?? 'mp4';
      const subDef = FORMAT_MAP.get(sub) ?? FORMAT_MAP.get('mp4')!;
      if (isEnabled(subDef.id) || isEnabled('mp4')) {
        return {
          formatId: subDef.id,
          extension: sub,
          description: subDef.description,
          family: subDef.family,
          mimeType: subDef.mimeType,
          matchedOffset: 4,
          matchedLength: 4,
          calculatedSize: mp4.size,
          status: mp4.truncated ? 'OK_TRUNCATED' : 'OK',
          metadata: mp4.meta,
        };
      }
    }
  }

  // 14. MP3 ID3v2
  if (isEnabled('mp3') && buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const tagSize =
      ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    const def = FORMAT_MAP.get('mp3')!;
    return {
      formatId: 'mp3',
      extension: 'mp3',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 3,
      calculatedSize: buf.length,
      sizeEstimated: true,
      status: 'HEADER_ONLY',
      metadata: { details: `ID3v2.${buf[3]} tag (${tagSize} B)` },
    };
  }

  // 15. FLAC
  if (isEnabled('flac') && buf.length >= 4 && readAscii(buf, 0, 4) === 'fLaC') {
    const def = FORMAT_MAP.get('flac')!;
    return {
      formatId: 'flac',
      extension: 'flac',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 4,
      calculatedSize: buf.length,
      sizeEstimated: true,
      status: 'HEADER_ONLY',
      metadata: { details: 'FLAC lossless audio stream' },
    };
  }

  // 16. OGG
  if (isEnabled('ogg') && buf.length >= 28 && readAscii(buf, 0, 4) === 'OggS') {
    const def = FORMAT_MAP.get('ogg')!;
    return {
      formatId: 'ogg',
      extension: 'ogg',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 4,
      calculatedSize: buf.length,
      sizeEstimated: true,
      status: 'HEADER_ONLY',
      metadata: { details: 'Ogg bitstream page container' },
    };
  }

  // 17. ELF
  if (isEnabled('elf') && buf.length >= 20 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    const elfClass = buf[4] === 2 ? '64-bit' : buf[4] === 1 ? '32-bit' : 'Unknown';
    const def = FORMAT_MAP.get('elf')!;
    return {
      formatId: 'elf',
      extension: 'elf',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 4,
      calculatedSize: buf.length,
      sizeEstimated: true,
      status: 'HEADER_ONLY',
      metadata: { details: `ELF ${elfClass} binary` },
    };
  }

  // 18. MZ / PE
  if (isEnabled('exe') && buf.length >= 64 && buf[0] === 0x4d && buf[1] === 0x5a) {
    const peOff = readUint32LE(buf, 60);
    if (peOff + 4 <= buf.length && readAscii(buf, peOff, 4) === 'PE\0\0') {
      const def = FORMAT_MAP.get('exe')!;
      return {
        formatId: 'exe',
        extension: 'exe',
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 2,
        calculatedSize: buf.length,
        sizeEstimated: true,
        status: 'HEADER_ONLY',
        metadata: { details: `PE/COFF header @ +0x${peOff.toString(16)}` },
      };
    }
  }

  // 18b. Creative, CAD, Mail, Video, Archive & System Signatures (PSD, DWG, PST, MKV, FLV, RPA, EVTX, LNK, PCAP, BLEND, GLB, EXR, DDS, CAB, ZST, TAR, WMV)
  if (isEnabled('psd') || isEnabled('psb')) {
    if (buf.length >= 26 && readAscii(buf, 0, 4) === '8BPS') {
      const ver = readUint16BE(buf, 4);
      if (ver === 1 || ver === 2) {
        const id = ver === 2 ? 'psb' : 'psd';
        if (isEnabled(id)) {
          const def = FORMAT_MAP.get(id)!;
          const h = readUint32BE(buf, 14);
          const w = readUint32BE(buf, 18);
          return {
            formatId: id,
            extension: id,
            description: def.description,
            family: def.family,
            mimeType: def.mimeType,
            matchedOffset: 0,
            matchedLength: 6,
            calculatedSize: buf.length,
            sizeEstimated: true,
            status: 'HEADER_ONLY',
            metadata: { width: w, height: h, details: `Photoshop ${w}x${h} px (${id.toUpperCase()})` },
          };
        }
      }
    }
  }

  if (isEnabled('pst') || isEnabled('ost')) {
    if (buf.length >= 512 && buf[0] === 0x21 && buf[1] === 0x42 && buf[2] === 0x44 && buf[3] === 0x4e) {
      const subMagic = readAscii(buf, 8, 2);
      const id = subMagic === 'SO' ? 'ost' : 'pst';
      if (isEnabled(id)) {
        const wVer = readUint16LE(buf, 10);
        const calc = wVer >= 23 && buf.length >= 0xc0
          ? readUint32LE(buf, 0xbc) * 4294967296 + readUint32LE(buf, 0xb8)
          : buf.length >= 0xac ? readUint32LE(buf, 0xa8) : buf.length;
        const def = FORMAT_MAP.get(id)!;
        return {
          formatId: id,
          extension: id,
          description: def.description,
          family: def.family,
          mimeType: def.mimeType,
          matchedOffset: 0,
          matchedLength: 4,
          calculatedSize: calc > 512 ? Math.min(calc, 500 * MB) : buf.length,
          sizeEstimated: calc <= 512,
          status: calc > 512 && calc <= buf.length ? 'OK' : calc > buf.length ? 'OK_TRUNCATED' : 'HEADER_ONLY',
          metadata: { details: `Outlook ${id.toUpperCase()} (NDB v${wVer})` },
        };
      }
    }
  }

  if ((isEnabled('mkv') || isEnabled('webm')) && buf.length >= 16 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    const docType = readAscii(buf, 0, Math.min(buf.length, 64)).includes('webm') ? 'webm' : 'mkv';
    if (isEnabled(docType)) {
      const def = FORMAT_MAP.get(docType)!;
      return {
        formatId: docType,
        extension: docType,
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 4,
        calculatedSize: buf.length,
        sizeEstimated: true,
        status: 'HEADER_ONLY',
        metadata: { subExtension: docType, details: `EBML Matroska (${docType.toUpperCase()})` },
      };
    }
  }

  if (isEnabled('dwg') && buf.length >= 16 && /^AC10(1[2-9]|2[0-9]|3[0-9])/.test(readAscii(buf, 0, 6))) {
    const def = FORMAT_MAP.get('dwg')!;
    return {
      formatId: 'dwg',
      extension: 'dwg',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 6,
      calculatedSize: buf.length,
      sizeEstimated: true,
      status: 'HEADER_ONLY',
      metadata: { details: `AutoCAD ${readAscii(buf, 0, 6)}` },
    };
  }

  if (isEnabled('blend') && buf.length >= 12 && readAscii(buf, 0, 7) === 'BLENDER') {
    const def = FORMAT_MAP.get('blend')!;
    return {
      formatId: 'blend',
      extension: 'blend',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 7,
      calculatedSize: buf.length,
      sizeEstimated: true,
      status: 'HEADER_ONLY',
      metadata: { details: `Blender ${readAscii(buf, 9, 3)} project` },
    };
  }

  if (isEnabled('glb') && buf.length >= 12 && readAscii(buf, 0, 4) === 'glTF' && readUint32LE(buf, 4) === 2) {
    const glbSize = readUint32LE(buf, 8);
    const def = FORMAT_MAP.get('glb')!;
    return {
      formatId: 'glb',
      extension: 'glb',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 8,
      calculatedSize: glbSize,
      status: glbSize <= buf.length ? 'OK' : 'OK_TRUNCATED',
      metadata: { details: `glTF 2.0 Binary (${glbSize} B)` },
    };
  }

  if (isEnabled('rpa') && buf.length >= 24 && /^RPA-(3\.0|2\.0) [0-9a-fA-F]{16}/.test(readAscii(buf, 0, 24))) {
    const def = FORMAT_MAP.get('rpa')!;
    return {
      formatId: 'rpa',
      extension: 'rpa',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 7,
      calculatedSize: buf.length,
      sizeEstimated: true,
      status: 'HEADER_ONLY',
      metadata: { details: `Ren'Py Archive (${readAscii(buf, 0, 7)})` },
    };
  }

  if (isEnabled('rpyc') && buf.length >= 12 && readAscii(buf, 0, 10) === 'RENPY RPC2') {
    const def = FORMAT_MAP.get('rpyc')!;
    return {
      formatId: 'rpyc',
      extension: 'rpyc',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 10,
      calculatedSize: buf.length,
      sizeEstimated: true,
      status: 'HEADER_ONLY',
      metadata: { details: "Ren'Py Compiled RPC2 Script" },
    };
  }

  if (isEnabled('evtx') && buf.length >= 16 && readAscii(buf, 0, 8) === 'ElfFile\0') {
    const def = FORMAT_MAP.get('evtx')!;
    return {
      formatId: 'evtx',
      extension: 'evtx',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 8,
      calculatedSize: buf.length,
      sizeEstimated: true,
      status: 'HEADER_ONLY',
      metadata: { details: 'Windows XML Event Log' },
    };
  }

  if (isEnabled('lnk') && buf.length >= 20 && buf[0] === 0x4c && buf[1] === 0x00 && buf[2] === 0x00 && buf[3] === 0x00 && buf[4] === 0x01 && buf[5] === 0x14 && buf[6] === 0x02 && buf[7] === 0x00) {
    const def = FORMAT_MAP.get('lnk')!;
    return {
      formatId: 'lnk',
      extension: 'lnk',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 8,
      calculatedSize: Math.min(buf.length, 65536),
      sizeEstimated: true,
      status: 'OK',
      metadata: { details: 'Windows Shell Shortcut (.lnk)' },
    };
  }

  if (isEnabled('pcap') && buf.length >= 24 && ((buf[0] === 0xd4 && buf[1] === 0xc3 && buf[2] === 0xb2 && buf[3] === 0xa1) || (buf[0] === 0xa1 && buf[1] === 0xb2 && buf[2] === 0xc3 && buf[3] === 0xd4))) {
    const def = FORMAT_MAP.get('pcap')!;
    return { formatId: 'pcap', extension: 'pcap', description: def.description, family: def.family, mimeType: def.mimeType, matchedOffset: 0, matchedLength: 4, calculatedSize: buf.length, sizeEstimated: true, status: 'HEADER_ONLY', metadata: { details: 'libpcap Network Capture' } };
  }

  if (isEnabled('pcapng') && buf.length >= 12 && buf[0] === 0x0a && buf[1] === 0x0d && buf[2] === 0x0d && buf[3] === 0x0a) {
    const def = FORMAT_MAP.get('pcapng')!;
    return { formatId: 'pcapng', extension: 'pcapng', description: def.description, family: def.family, mimeType: def.mimeType, matchedOffset: 0, matchedLength: 4, calculatedSize: buf.length, sizeEstimated: true, status: 'HEADER_ONLY', metadata: { details: 'PCAP-NG Network Capture' } };
  }

  if (isEnabled('flv') && buf.length >= 9 && buf[0] === 0x46 && buf[1] === 0x4c && buf[2] === 0x56 && buf[3] === 0x01) {
    const def = FORMAT_MAP.get('flv')!;
    return { formatId: 'flv', extension: 'flv', description: def.description, family: def.family, mimeType: def.mimeType, matchedOffset: 0, matchedLength: 4, calculatedSize: buf.length, sizeEstimated: true, status: 'HEADER_ONLY', metadata: { details: 'Adobe Flash Video' } };
  }

  if ((isEnabled('wmv') || isEnabled('wma')) && buf.length >= 30 && buf[0] === 0x30 && buf[1] === 0x26 && buf[2] === 0xb2 && buf[3] === 0x75 && buf[4] === 0x8e && buf[5] === 0x66 && buf[6] === 0xcf && buf[7] === 0x11) {
    const wId = isEnabled('wmv') ? 'wmv' : 'wma';
    const def = FORMAT_MAP.get(wId)!;
    return { formatId: wId, extension: wId, description: def.description, family: def.family, mimeType: def.mimeType, matchedOffset: 0, matchedLength: 8, calculatedSize: buf.length, sizeEstimated: true, status: 'HEADER_ONLY', metadata: { details: 'Microsoft ASF / WMV Stream' } };
  }

  if (isEnabled('cab') && buf.length >= 36 && readAscii(buf, 0, 4) === 'MSCF' && readUint32LE(buf, 8) > 36) {
    const calc = readUint32LE(buf, 8);
    const def = FORMAT_MAP.get('cab')!;
    return { formatId: 'cab', extension: 'cab', description: def.description, family: def.family, mimeType: def.mimeType, matchedOffset: 0, matchedLength: 4, calculatedSize: calc, status: calc <= buf.length ? 'OK' : 'OK_TRUNCATED', metadata: { details: `Microsoft CAB (${calc} B)` } };
  }

  if (isEnabled('zst') && buf.length >= 8 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd) {
    const def = FORMAT_MAP.get('zst')!;
    return { formatId: 'zst', extension: 'zst', description: def.description, family: def.family, mimeType: def.mimeType, matchedOffset: 0, matchedLength: 4, calculatedSize: buf.length, sizeEstimated: true, status: 'HEADER_ONLY', metadata: { details: 'Zstandard Frame Stream' } };
  }

  if (isEnabled('xz') && buf.length >= 12 && buf[0] === 0xfd && buf[1] === 0x37 && buf[2] === 0x7a && buf[3] === 0x58 && buf[4] === 0x5a && buf[5] === 0x00) {
    const def = FORMAT_MAP.get('xz')!;
    return { formatId: 'xz', extension: 'xz', description: def.description, family: def.family, mimeType: def.mimeType, matchedOffset: 0, matchedLength: 6, calculatedSize: buf.length, sizeEstimated: true, status: 'HEADER_ONLY', metadata: { details: 'XZ / LZMA2 Archive' } };
  }

  if (isEnabled('bz2') && buf.length >= 10 && buf[0] === 0x42 && buf[1] === 0x5a && buf[2] === 0x68 && buf[3] >= 0x31 && buf[3] <= 0x39) {
    const def = FORMAT_MAP.get('bz2')!;
    return { formatId: 'bz2', extension: 'bz2', description: def.description, family: def.family, mimeType: def.mimeType, matchedOffset: 0, matchedLength: 3, calculatedSize: buf.length, sizeEstimated: true, status: 'HEADER_ONLY', metadata: { details: `Bzip2 Block Level ${String.fromCharCode(buf[3])}` } };
  }

  if (isEnabled('tar') && buf.length >= 512 && readAscii(buf, 257, 5) === 'ustar') {
    const def = FORMAT_MAP.get('tar')!;
    return { formatId: 'tar', extension: 'tar', description: def.description, family: def.family, mimeType: def.mimeType, matchedOffset: 257, matchedLength: 5, calculatedSize: buf.length, sizeEstimated: true, status: 'HEADER_ONLY', metadata: { details: 'POSIX USTAR Tape Archive' } };
  }

  if (isEnabled('exr') && buf.length >= 8 && buf[0] === 0x76 && buf[1] === 0x2f && buf[2] === 0x31 && buf[3] === 0x01) {
    const def = FORMAT_MAP.get('exr')!;
    return { formatId: 'exr', extension: 'exr', description: def.description, family: def.family, mimeType: def.mimeType, matchedOffset: 0, matchedLength: 4, calculatedSize: buf.length, sizeEstimated: true, status: 'HEADER_ONLY', metadata: { details: 'OpenEXR High Dynamic Range' } };
  }

  if (isEnabled('dds') && buf.length >= 128 && readAscii(buf, 0, 4) === 'DDS ' && readUint32LE(buf, 4) === 124) {
    const def = FORMAT_MAP.get('dds')!;
    return { formatId: 'dds', extension: 'dds', description: def.description, family: def.family, mimeType: def.mimeType, matchedOffset: 0, matchedLength: 8, calculatedSize: buf.length, sizeEstimated: true, status: 'HEADER_ONLY', metadata: { width: readUint32LE(buf, 16), height: readUint32LE(buf, 12), details: 'DirectDraw Surface Texture' } };
  }

  if (isEnabled('otf') && buf.length >= 12 && readAscii(buf, 0, 4) === 'OTTO') {
    const def = FORMAT_MAP.get('otf')!;
    return { formatId: 'otf', extension: 'otf', description: def.description, family: def.family, mimeType: def.mimeType, matchedOffset: 0, matchedLength: 4, calculatedSize: buf.length, sizeEstimated: true, status: 'HEADER_ONLY', metadata: { details: 'OpenType CFF Font' } };
  }

  if ((isEnabled('woff') || isEnabled('woff2')) && buf.length >= 12 && (readAscii(buf, 0, 4) === 'wOFF' || readAscii(buf, 0, 4) === 'wOF2')) {
    const id = readAscii(buf, 0, 4) === 'wOF2' ? 'woff2' : 'woff';
    const def = FORMAT_MAP.get(id)!;
    const calc = readUint32BE(buf, 8);
    return { formatId: id, extension: id, description: def.description, family: def.family, mimeType: def.mimeType, matchedOffset: 0, matchedLength: 4, calculatedSize: calc || buf.length, sizeEstimated: !calc, status: calc && calc <= buf.length ? 'OK' : 'OK_TRUNCATED', metadata: { details: `${id.toUpperCase()} Web Font` } };
  }

  if (isEnabled('ts') && buf.length >= 564 && buf[0] === 0x47 && buf[188] === 0x47 && buf[376] === 0x47) {
    const def = FORMAT_MAP.get('ts')!;
    return { formatId: 'ts', extension: 'ts', description: def.description, family: def.family, mimeType: def.mimeType, matchedOffset: 0, matchedLength: 1, calculatedSize: buf.length, sizeEstimated: true, status: 'HEADER_ONLY', metadata: { details: 'MPEG-2 Transport Stream (188-byte sync)' } };
  }

  if (isEnabled('rtf') && buf.length >= 8 && readAscii(buf, 0, 6) === '{\\rtf1') {
    const def = FORMAT_MAP.get('rtf')!;
    return { formatId: 'rtf', extension: 'rtf', description: def.description, family: def.family, mimeType: def.mimeType, matchedOffset: 0, matchedLength: 6, calculatedSize: buf.length, sizeEstimated: true, status: 'HEADER_ONLY', metadata: { details: 'Rich Text Format Document' } };
  }

  if (isEnabled('torrent') && buf.length >= 16 && readAscii(buf, 0, 11) === 'd8:announce') {
    const def = FORMAT_MAP.get('torrent')!;
    return { formatId: 'torrent', extension: 'torrent', description: def.description, family: def.family, mimeType: def.mimeType, matchedOffset: 0, matchedLength: 11, calculatedSize: buf.length, sizeEstimated: true, status: 'HEADER_ONLY', metadata: { details: 'BitTorrent Metainfo' } };
  }

  if (isEnabled('kdbx') && buf.length >= 12 && buf[0] === 0x03 && buf[1] === 0xd9 && buf[2] === 0xa2 && buf[3] === 0x9a) {
    const def = FORMAT_MAP.get('kdbx')!;
    return { formatId: 'kdbx', extension: 'kdbx', description: def.description, family: def.family, mimeType: def.mimeType, matchedOffset: 0, matchedLength: 4, calculatedSize: buf.length, sizeEstimated: true, status: 'HEADER_ONLY', metadata: { details: 'KeePass Password Database' } };
  }

  // 19. Printable UTF-8 / JSON / XML / AEPX / RPY / EML
  if ((isEnabled('txt') || isEnabled('aepx') || isEnabled('rpy') || isEnabled('json') || isEnabled('xml') || isEnabled('svg')) && buf.length >= 4) {
    const sampleLen = Math.min(buf.length, 512);
    let printable = 0;
    for (let i = 0; i < sampleLen; i++) {
      const b = buf[i];
      if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126) || b >= 0xc2) {
        printable++;
      }
    }
    if (printable / sampleLen > 0.94) {
      const head = readAscii(buf, 0, Math.min(buf.length, 256)).trimStart();
      let ext = 'txt';
      let desc = 'UTF-8 / ASCII Plain Text';
      let mime = 'text/plain';
      if (head.startsWith('<?xml') || head.startsWith('<svg')) {
        if (head.includes('AfterEffectsProject')) {
          ext = 'aepx';
          desc = 'Adobe After Effects XML Project (.aepx)';
          mime = 'application/xml';
        } else {
          ext = head.startsWith('<svg') ? 'svg' : 'xml';
          desc = 'XML / SVG Markup Document';
          mime = ext === 'svg' ? 'image/svg+xml' : 'application/xml';
        }
      } else if (/^<!doctype\s+(html|netscape-bookmark)/i.test(head) || /^<html/i.test(head)) {
        ext = 'html';
        desc = /netscape-bookmark/i.test(head) ? 'Browser Bookmarks Export (HTML)' : 'HTML Web Document';
        mime = 'text/html';
      } else if (/^(From:|Return-Path:|MIME-Version:|Message-ID:)/m.test(head) && /^Subject:/m.test(head)) {
        ext = 'eml';
        desc = 'RFC 822 Email Message (.eml)';
        mime = 'message/rfc822';
      } else if (/^(label\s+start:|init\s+(?:\d+\s+)?python:|define\s+[a-zA-Z_]+\s*=\s*Character\()/m.test(head)) {
        ext = 'rpy';
        desc = "Ren'Py Script Source (.rpy)";
        mime = 'text/plain';
      } else if (head.startsWith('{') || head.startsWith('[')) {
        try {
          JSON.parse(new TextDecoder().decode(buf.subarray(0, Math.min(buf.length, 65536))));
          ext = 'json';
          desc = 'JSON Structured Data';
          mime = 'application/json';
        } catch {
          // keep txt
        }
      }
      if (isEnabled(ext) || isEnabled('txt')) {
        return {
          formatId: FORMAT_MAP.has(ext) ? ext : 'txt',
          extension: ext,
          description: desc,
          family: ext === 'svg' ? 'Pictures' : 'Documents',
          mimeType: mime,
          matchedOffset: 0,
          matchedLength: 0,
          calculatedSize: buf.length,
          sizeEstimated: true,
          status: 'OK',
          metadata: { details: `${buf.length} bytes printable text` },
        };
      }
    }
  }

  // 19b. Windows UTF-16LE Text / INI / REG / Log
  if (isEnabled('txt') && buf.length >= 8) {
    const hasUtf16Bom = buf[0] === 0xff && buf[1] === 0xfe;
    const samplePairs = Math.min(256, Math.floor(buf.length / 2));
    let asciiLePairs = 0;
    for (let p = hasUtf16Bom ? 1 : 0; p < samplePairs; p++) {
      const lo = buf[p * 2];
      const hi = buf[p * 2 + 1];
      if (hi === 0 && (lo === 9 || lo === 10 || lo === 13 || (lo >= 32 && lo <= 126))) {
        asciiLePairs++;
      }
    }
    const denom = hasUtf16Bom ? Math.max(1, samplePairs - 1) : samplePairs;
    if (denom >= 4 && asciiLePairs / denom >= 0.85) {
      return {
        formatId: 'txt',
        extension: 'txt',
        description: 'Windows UTF-16LE Unicode Text',
        family: 'Documents',
        mimeType: 'text/plain',
        matchedOffset: 0,
        matchedLength: hasUtf16Bom ? 2 : 0,
        calculatedSize: buf.length,
        sizeEstimated: true,
        status: 'OK',
        metadata: { details: `${buf.length} bytes UTF-16LE text` },
      };
    }
  }

  return null;
}

/**
 * PhotoRec-inspired sector-by-sector carver across a binary disk or partition range.
 */
export function carveDiskBuffer(
  diskBytes: Uint8Array,
  options: CarveOptions,
): CarvedFile[] {
  const results: CarvedFile[] = [];
  const start = Math.max(0, options.startByte);
  const end = Math.min(diskBytes.length, options.endByte);
  const step = Math.max(512, options.blockSize);
  let fileIndex = 1;
  let cursor = start;

  while (cursor + 16 <= end) {
    if (options.unallocatedOnly && options.allocatedChecker?.(cursor)) {
      cursor += step;
      continue;
    }

    const b0 = diskBytes[cursor];
    const b1 = diskBytes[cursor + 1];
    const b2 = diskBytes[cursor + 2];
    const b3 = diskBytes[cursor + 3];
    const b4 = diskBytes[cursor + 4];

    // Fast signature pre-filter (like PhotoRec's file_check_list[buffer[offset]])
    const maybeMatch =
      (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) ||
      (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e) ||
      (b0 === 0x47 && b1 === 0x49 && b2 === 0x46) ||
      (b0 === 0x42 && b1 === 0x4d) ||
      (b0 === 0x52 && b1 === 0x49 && b2 === 0x46) ||
      (b0 === 0x49 && b1 === 0x49 && ((b2 === 0x2a && b3 === 0x00) || (b2 === 0x52 && b3 === 0x4f) || (b2 === 0x55 && b3 === 0x00))) ||
      (b0 === 0x4d && b1 === 0x4d && ((b2 === 0x00 && b3 === 0x2a) || (b2 === 0x4f && b3 === 0x52))) ||
      (b0 === 0x46 && b1 === 0x55 && b2 === 0x4a && b3 === 0x49) ||
      (b0 === 0x25 && b1 === 0x50 && b2 === 0x44) ||
      (b0 === 0x50 && b1 === 0x4b && b2 === 0x03) ||
      (b0 === 0xd0 && b1 === 0xcf && b2 === 0x11 && b3 === 0xe0) ||
      (b0 === 0x37 && b1 === 0x7a && b2 === 0xbc) ||
      (b0 === 0x1f && b1 === 0x8b && b2 === 0x08) ||
      (b0 === 0x52 && b1 === 0x61 && b2 === 0x72) ||
      (b0 === 0x53 && b1 === 0x51 && b2 === 0x4c) ||
      (b4 === 0x66 && diskBytes[cursor + 5] === 0x74 && diskBytes[cursor + 6] === 0x79) ||
      (b0 === 0x49 && b1 === 0x44 && b2 === 0x33) ||
      (b0 === 0x66 && b1 === 0x4c && b2 === 0x61) ||
      (b0 === 0x4f && b1 === 0x67 && b2 === 0x67) ||
      (b0 === 0x7f && b1 === 0x45 && b2 === 0x4c) ||
      (b0 === 0x4d && b1 === 0x5a) ||
      (b0 === 0x00 && b1 === 0x00 && (b2 === 0x01 || b2 === 0x02) && b3 === 0x00) ||
      (b0 === 0x38 && b1 === 0x42 && b2 === 0x50 && b3 === 0x53) ||
      (b0 === 0x21 && b1 === 0x42 && b2 === 0x44 && b3 === 0x4e) ||
      (b0 === 0x1a && b1 === 0x45 && b2 === 0xdf && b3 === 0xa3) ||
      (b0 === 0x41 && b1 === 0x43 && b2 === 0x31 && b3 === 0x30) ||
      (b0 === 0x42 && b1 === 0x4c && b2 === 0x45 && b3 === 0x4e) ||
      (b0 === 0x67 && b1 === 0x6c && b2 === 0x54 && b3 === 0x46) ||
      (b0 === 0x52 && b1 === 0x50 && b2 === 0x41 && b3 === 0x2d) ||
      (b0 === 0x52 && b1 === 0x45 && b2 === 0x4e && b3 === 0x50) ||
      (b0 === 0x45 && b1 === 0x6c && b2 === 0x66 && b3 === 0x46) ||
      (b0 === 0x4c && b1 === 0x00 && b2 === 0x00 && b3 === 0x00) ||
      (b0 === 0x30 && b1 === 0x26 && b2 === 0xb2 && b3 === 0x75) ||
      (b0 === 0x46 && b1 === 0x4c && b2 === 0x56 && b3 === 0x01) ||
      (b0 === 0x4d && b1 === 0x53 && b2 === 0x43 && b3 === 0x46) ||
      (b0 === 0x28 && b1 === 0xb5 && b2 === 0x2f && b3 === 0xfd) ||
      (b0 === 0xfd && b1 === 0x37 && b2 === 0x7a && b3 === 0x58) ||
      (b0 === 0x42 && b1 === 0x5a && b2 === 0x68) ||
      (b0 === 0x76 && b1 === 0x2f && b2 === 0x31 && b3 === 0x01) ||
      (b0 === 0x44 && b1 === 0x44 && b2 === 0x53 && b3 === 0x20) ||
      (b0 === 0x0a && b1 === 0x0d && b2 === 0x0d && b3 === 0x0a) ||
      (b0 === 0xd4 && b1 === 0xc3 && b2 === 0xb2 && b3 === 0xa1) ||
      (b0 === 0x7b && b1 === 0x5c && b2 === 0x72 && b3 === 0x74) ||
      (b0 === 0x47 && cursor + 377 < end && diskBytes[cursor + 188] === 0x47 && diskBytes[cursor + 376] === 0x47) ||
      (cursor + 262 < end && diskBytes[cursor + 257] === 0x75 && diskBytes[cursor + 258] === 0x73 && diskBytes[cursor + 259] === 0x74);

    if (maybeMatch) {
      const slice = diskBytes.subarray(cursor, Math.min(end, cursor + 16 * MB));
      const match = identifyBuffer(slice, options.enabledFormats);
      if (match && match.calculatedSize && match.calculatedSize >= 16) {
        const isTruncated = match.status === 'OK_TRUNCATED';
        if (!isTruncated || !options.paranoid || options.keepCorrupted) {
          let clampedSize = Math.min(match.calculatedSize, end - cursor);
          let effectiveTruncated = isTruncated;
          if (['mp4', 'mov', 'm4v', '3gp'].includes(match.extension) && clampedSize > step) {
            for (let probe = cursor + step; probe + 12 <= cursor + clampedSize; probe += step) {
              const p0 = diskBytes[probe];
              const p1 = diskBytes[probe + 1];
              const p2 = diskBytes[probe + 2];
              const p3 = diskBytes[probe + 3];
              const isForeign =
                (p0 === 0xff && p1 === 0xd8 && p2 === 0xff) ||
                (p0 === 0x89 && p1 === 0x50 && p2 === 0x4e && p3 === 0x47) ||
                (p0 === 0x47 && p1 === 0x49 && p2 === 0x46 && p3 === 0x38) ||
                (p0 === 0x25 && p1 === 0x50 && p2 === 0x44 && p3 === 0x46) ||
                (p0 === 0x50 && p1 === 0x4b && p2 === 0x03 && p3 === 0x04) ||
                (p0 === 0xd0 && p1 === 0xcf && p2 === 0x11 && p3 === 0xe0) ||
                (diskBytes[probe + 4] === 0x66 && diskBytes[probe + 5] === 0x74 && diskBytes[probe + 6] === 0x79 && diskBytes[probe + 7] === 0x70);
              if (isForeign) {
                clampedSize = probe - cursor;
                effectiveTruncated = true;
                break;
              }
            }
          }
          const dirNum = Math.floor((fileIndex - 1) / 500) + 1;
          const recupDir = `recup_dir.${dirNum}`;
          const sector = Math.floor(cursor / 512);
          const padNum = String(fileIndex).padStart(4, '0');
          const carvedData = diskBytes.slice(cursor, cursor + clampedSize);
          const discoveryCrc32 = computeCrc32(carvedData, 0, Math.min(65536, carvedData.length));

          results.push({
            id: `${cursor}-${match.extension}`,
            filename: `f${String(sector).padStart(7, '0')}_${padNum}.${match.extension}`,
            recupDir,
            formatId: match.formatId,
            extension: match.extension,
            description: match.description,
            family: match.family,
            mimeType: match.mimeType,
            offset: cursor,
            sector,
            size: clampedSize,
            calculatedSize: match.calculatedSize,
            sizeEstimated: Boolean(match.sizeEstimated),
            status: effectiveTruncated || match.sizeEstimated ? 'OK_TRUNCATED' : 'OK',
            metadata: match.metadata,
            data: carvedData,
            discoveryCrc32,
          });

          fileIndex++;
          // Only jump past files with verified structural bounds; for guessed HEADER_ONLY caps, step forward by 1 block (#9)
          const alignedAdvance = match.sizeEstimated
            ? step
            : Math.max(step, Math.ceil(clampedSize / step) * step);
          cursor += alignedAdvance;
          continue;
        }
      }
    }

    cursor += step;
  }

  return stitchFragmentedVideosInBuffer(diskBytes, results, {
    blockSize: step,
    unallocatedOnly: options.unallocatedOnly,
    allocatedChecker: options.allocatedChecker,
  });
}

export interface AsyncCarveControls {
  isCancelled: () => boolean;
  isPaused: () => boolean;
  onBatch?: (batch: CarvedFile[]) => void;
}

/**
 * Chunked asynchronous carver that yields to the main thread and streams live sector progress and file batches.
 */
export async function carveDiskBufferAsync(
  diskBytes: Uint8Array,
  options: CarveOptions,
  onProgress: (progress: CarveProgress) => void,
  controls?: AsyncCarveControls,
): Promise<CarvedFile[]> {
  const results: CarvedFile[] = [];
  let pendingBatch: CarvedFile[] = [];
  const start = Math.max(0, options.startByte);
  const end = Math.min(diskBytes.length, options.endByte);
  const step = Math.max(512, options.blockSize);
  const totalSectors = Math.max(1, Math.floor((end - start) / 512));
  let fileIndex = 1;
  let foundBytes = 0;
  let cursor = start;
  let stepsSinceYield = 0;

  const flushBatch = () => {
    if (pendingBatch.length > 0 && controls?.onBatch) {
      controls.onBatch(pendingBatch);
      pendingBatch = [];
    }
  };

  while (cursor + 16 <= end) {
    if (controls?.isCancelled()) {
      break;
    }
    while (controls?.isPaused()) {
      if (controls.isCancelled()) break;
      await new Promise((r) => setTimeout(r, 80));
    }
    if (controls?.isCancelled()) {
      break;
    }

    if (options.unallocatedOnly && options.allocatedChecker?.(cursor)) {
      cursor += step;
      stepsSinceYield++;
      if (stepsSinceYield >= 1200) {
        stepsSinceYield = 0;
        flushBatch();
        const currentSector = Math.floor((cursor - start) / 512);
        onProgress({
          currentSector,
          totalSectors,
          percent: Math.min(99, Math.round((currentSector / totalSectors) * 100)),
          foundCount: results.length,
          foundBytes,
        });
        await new Promise((r) => setTimeout(r, 0));
      }
      continue;
    }

    const b0 = diskBytes[cursor];
    const b1 = diskBytes[cursor + 1];
    const b2 = diskBytes[cursor + 2];
    const b3 = diskBytes[cursor + 3];
    const b4 = diskBytes[cursor + 4];

    const maybeMatch =
      (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) ||
      (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e) ||
      (b0 === 0x47 && b1 === 0x49 && b2 === 0x46) ||
      (b0 === 0x42 && b1 === 0x4d) ||
      (b0 === 0x52 && b1 === 0x49 && b2 === 0x46) ||
      (b0 === 0x49 && b1 === 0x49 && ((b2 === 0x2a && b3 === 0x00) || (b2 === 0x52 && b3 === 0x4f) || (b2 === 0x55 && b3 === 0x00))) ||
      (b0 === 0x4d && b1 === 0x4d && ((b2 === 0x00 && b3 === 0x2a) || (b2 === 0x4f && b3 === 0x52))) ||
      (b0 === 0x46 && b1 === 0x55 && b2 === 0x4a && b3 === 0x49) ||
      (b0 === 0x25 && b1 === 0x50 && b2 === 0x44) ||
      (b0 === 0x50 && b1 === 0x4b && b2 === 0x03) ||
      (b0 === 0xd0 && b1 === 0xcf && b2 === 0x11 && b3 === 0xe0) ||
      (b0 === 0x37 && b1 === 0x7a && b2 === 0xbc) ||
      (b0 === 0x1f && b1 === 0x8b && b2 === 0x08) ||
      (b0 === 0x52 && b1 === 0x61 && b2 === 0x72) ||
      (b0 === 0x53 && b1 === 0x51 && b2 === 0x4c) ||
      (b4 === 0x66 && diskBytes[cursor + 5] === 0x74 && diskBytes[cursor + 6] === 0x79) ||
      (b0 === 0x49 && b1 === 0x44 && b2 === 0x33) ||
      (b0 === 0x66 && b1 === 0x4c && b2 === 0x61) ||
      (b0 === 0x4f && b1 === 0x67 && b2 === 0x67) ||
      (b0 === 0x7f && b1 === 0x45 && b2 === 0x4c) ||
      (b0 === 0x4d && b1 === 0x5a) ||
      (b0 === 0x00 && b1 === 0x00 && (b2 === 0x01 || b2 === 0x02) && b3 === 0x00) ||
      (b0 === 0x38 && b1 === 0x42 && b2 === 0x50 && b3 === 0x53) ||
      (b0 === 0x21 && b1 === 0x42 && b2 === 0x44 && b3 === 0x4e) ||
      (b0 === 0x1a && b1 === 0x45 && b2 === 0xdf && b3 === 0xa3) ||
      (b0 === 0x41 && b1 === 0x43 && b2 === 0x31 && b3 === 0x30) ||
      (b0 === 0x42 && b1 === 0x4c && b2 === 0x45 && b3 === 0x4e) ||
      (b0 === 0x67 && b1 === 0x6c && b2 === 0x54 && b3 === 0x46) ||
      (b0 === 0x52 && b1 === 0x50 && b2 === 0x41 && b3 === 0x2d) ||
      (b0 === 0x52 && b1 === 0x45 && b2 === 0x4e && b3 === 0x50) ||
      (b0 === 0x45 && b1 === 0x6c && b2 === 0x66 && b3 === 0x46) ||
      (b0 === 0x4c && b1 === 0x00 && b2 === 0x00 && b3 === 0x00) ||
      (b0 === 0x30 && b1 === 0x26 && b2 === 0xb2 && b3 === 0x75) ||
      (b0 === 0x46 && b1 === 0x4c && b2 === 0x56 && b3 === 0x01) ||
      (b0 === 0x4d && b1 === 0x53 && b2 === 0x43 && b3 === 0x46) ||
      (b0 === 0x28 && b1 === 0xb5 && b2 === 0x2f && b3 === 0xfd) ||
      (b0 === 0xfd && b1 === 0x37 && b2 === 0x7a && b3 === 0x58) ||
      (b0 === 0x42 && b1 === 0x5a && b2 === 0x68) ||
      (b0 === 0x76 && b1 === 0x2f && b2 === 0x31 && b3 === 0x01) ||
      (b0 === 0x44 && b1 === 0x44 && b2 === 0x53 && b3 === 0x20) ||
      (b0 === 0x0a && b1 === 0x0d && b2 === 0x0d && b3 === 0x0a) ||
      (b0 === 0xd4 && b1 === 0xc3 && b2 === 0xb2 && b3 === 0xa1) ||
      (b0 === 0x7b && b1 === 0x5c && b2 === 0x72 && b3 === 0x74) ||
      (b0 === 0x47 && cursor + 377 < end && diskBytes[cursor + 188] === 0x47 && diskBytes[cursor + 376] === 0x47) ||
      (cursor + 262 < end && diskBytes[cursor + 257] === 0x75 && diskBytes[cursor + 258] === 0x73 && diskBytes[cursor + 259] === 0x74);

    if (maybeMatch) {
      const slice = diskBytes.subarray(cursor, Math.min(end, cursor + 16 * MB));
      const match = identifyBuffer(slice, options.enabledFormats);
      if (match && match.calculatedSize && match.calculatedSize >= 16) {
        const isTruncated = match.status === 'OK_TRUNCATED';
        if (!isTruncated || !options.paranoid || options.keepCorrupted) {
          let clampedSize = Math.min(match.calculatedSize, end - cursor);
          let effectiveTruncated = isTruncated;
          if (['mp4', 'mov', 'm4v', '3gp'].includes(match.extension) && clampedSize > step) {
            for (let probe = cursor + step; probe + 12 <= cursor + clampedSize; probe += step) {
              const p0 = diskBytes[probe];
              const p1 = diskBytes[probe + 1];
              const p2 = diskBytes[probe + 2];
              const p3 = diskBytes[probe + 3];
              const isForeign =
                (p0 === 0xff && p1 === 0xd8 && p2 === 0xff) ||
                (p0 === 0x89 && p1 === 0x50 && p2 === 0x4e && p3 === 0x47) ||
                (p0 === 0x47 && p1 === 0x49 && p2 === 0x46 && p3 === 0x38) ||
                (p0 === 0x25 && p1 === 0x50 && p2 === 0x44 && p3 === 0x46) ||
                (p0 === 0x50 && p1 === 0x4b && p2 === 0x03 && p3 === 0x04) ||
                (p0 === 0xd0 && p1 === 0xcf && p2 === 0x11 && p3 === 0xe0) ||
                (diskBytes[probe + 4] === 0x66 && diskBytes[probe + 5] === 0x74 && diskBytes[probe + 6] === 0x79 && diskBytes[probe + 7] === 0x70);
              if (isForeign) {
                clampedSize = probe - cursor;
                effectiveTruncated = true;
                break;
              }
            }
          }
          const dirNum = Math.floor((fileIndex - 1) / 500) + 1;
          const recupDir = `recup_dir.${dirNum}`;
          const sector = Math.floor(cursor / 512);
          const padNum = String(fileIndex).padStart(6, '0');
          const carvedData = diskBytes.slice(cursor, cursor + clampedSize);
          const discoveryCrc32 = computeCrc32(carvedData, 0, Math.min(65536, carvedData.length));

          const carved: CarvedFile = {
            id: `${cursor}-${match.extension}`,
            filename: `${match.extension.toUpperCase()}_${padNum}.${match.extension}`,
            recupDir,
            formatId: match.formatId,
            extension: match.extension,
            description: match.description,
            family: match.family,
            mimeType: match.mimeType,
            offset: cursor,
            sector,
            size: clampedSize,
            calculatedSize: match.calculatedSize,
            sizeEstimated: Boolean(match.sizeEstimated),
            status: effectiveTruncated || match.sizeEstimated ? 'OK_TRUNCATED' : 'OK',
            metadata: match.metadata,
            data: carvedData,
            discoveryCrc32,
          };

          results.push(carved);
          pendingBatch.push(carved);
          foundBytes += clampedSize;
          fileIndex++;

          const currentSector = Math.floor((cursor - start) / 512);
          onProgress({
            currentSector,
            totalSectors,
            percent: Math.min(99, Math.round((currentSector / totalSectors) * 100)),
            foundCount: results.length,
            foundBytes,
            latestFile: carved,
          });

          if (pendingBatch.length >= 16) {
            flushBatch();
          }

          const alignedAdvance = match.sizeEstimated
            ? step
            : Math.max(step, Math.ceil(clampedSize / step) * step);
          cursor += alignedAdvance;
          stepsSinceYield += 1;
          if (stepsSinceYield >= 400) {
            stepsSinceYield = 0;
            flushBatch();
            await new Promise((r) => setTimeout(r, 0));
          }
          continue;
        }
      }
    }

    cursor += step;
    stepsSinceYield++;
    if (stepsSinceYield >= 1200) {
      stepsSinceYield = 0;
      flushBatch();
      const currentSector = Math.floor((cursor - start) / 512);
      onProgress({
        currentSector,
        totalSectors,
        percent: Math.min(99, Math.round((currentSector / totalSectors) * 100)),
        foundCount: results.length,
        foundBytes,
      });
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const stitchedResults = stitchFragmentedVideosInBuffer(diskBytes, results, {
    blockSize: step,
    unallocatedOnly: options.unallocatedOnly,
    allocatedChecker: options.allocatedChecker,
  });

  flushBatch();
  onProgress({
    currentSector: totalSectors,
    totalSectors,
    percent: 100,
    foundCount: stitchedResults.length,
    foundBytes: stitchedResults.reduce((s, r) => s + r.size, 0),
  });

  return stitchedResults;
}

