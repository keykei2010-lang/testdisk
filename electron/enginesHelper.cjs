const { execFile, execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pathLookupCache = new Map();

function findExecutableInPathSync(binName) {
  if (pathLookupCache.has(binName)) return pathLookupCache.get(binName);
  const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
  let found = null;
  try {
    const out = execFileSync(cmd, [binName], {
      windowsHide: true,
      timeout: 1500,
      encoding: 'utf8',
    });
    const first = String(out || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && fs.existsSync(l));
    if (first) found = first;
  } catch {
    found = null;
  }
  pathLookupCache.set(binName, found);
  return found;
}

function isProcessElevatedSync() {
  if (process.platform !== 'win32') {
    return typeof process.getuid === 'function' ? process.getuid() === 0 : false;
  }
  try {
    execFileSync('net.exe', ['session'], {
      windowsHide: true,
      timeout: 1500,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function getCandidateEngineDirs(options = {}) {
  const isElevated = options.elevated !== undefined ? Boolean(options.elevated) : isProcessElevatedSync();
  const isPackaged =
    options.packaged !== undefined
      ? Boolean(options.packaged)
      : Boolean(!process.defaultApp && process.resourcesPath);

  const dirs = [];
  if (process.resourcesPath) {
    dirs.push(path.join(process.resourcesPath, 'engines'));
  }
  dirs.push(path.join(__dirname, 'bin'));

  if (process.platform === 'win32') {
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    dirs.push(
      path.join(progFiles, 'ffmpeg', 'bin'),
      path.join(progFilesX86, 'ffmpeg', 'bin'),
      path.join(progFiles, 'The Sleuth Kit', 'bin'),
      path.join(progFilesX86, 'The Sleuth Kit', 'bin'),
      path.join(progFiles, 'TestDisk'),
      path.join(progFilesX86, 'TestDisk'),
    );
  }

  // Only allow user-writable/per-user package directories when NOT elevated and NOT packaged
  if (!isElevated && !isPackaged) {
    const appData =
      process.env.APPDATA ||
      (process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Roaming')
        : path.join(os.homedir(), '.config'));
    dirs.push(path.join(appData, 'Disk-Partition-Recovery-Explorer', 'engines'));

    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      const userProfile = process.env.USERPROFILE || os.homedir();
      const choco = process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey';

      dirs.push(
        'C:\\ffmpeg\\bin',
        path.join(userProfile, 'scoop', 'shims'),
        path.join(userProfile, 'scoop', 'apps', 'ffmpeg', 'current', 'bin'),
        path.join(choco, 'bin'),
      );

      const wingetRoot = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
      if (fs.existsSync(wingetRoot)) {
        try {
          for (const pkg of fs.readdirSync(wingetRoot).slice(0, 40)) {
            if (/ffmpeg|testdisk|sleuthkit/i.test(pkg)) {
              dirs.push(path.join(wingetRoot, pkg));
              dirs.push(path.join(wingetRoot, pkg, 'bin'));
            }
          }
        } catch {
          // ignore unreadable WinGet folder
        }
      }
    }
  }

  return dirs;
}

/**
 * Resolves engine binaries from trusted application directories (and System/ProgramFiles).
 * Skips user-writable folders and PATH lookup when running elevated or packaged.
 */
function findBinary(subFolder, baseNames, options = {}) {
  const isElevated = options.elevated !== undefined ? Boolean(options.elevated) : isProcessElevatedSync();
  const isPackaged =
    options.packaged !== undefined
      ? Boolean(options.packaged)
      : Boolean(!process.defaultApp && process.resourcesPath);

  const roots = getCandidateEngineDirs({ elevated: isElevated, packaged: isPackaged });
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of baseNames) {
      const p1 = path.join(root, subFolder, name);
      if (fs.existsSync(p1)) return p1;
      const p2 = path.join(root, name);
      if (fs.existsSync(p2)) return p2;
    }
  }
  if (!isElevated && !isPackaged) {
    for (const name of baseNames) {
      const inPath = findExecutableInPathSync(name);
      if (inPath) return inPath;
    }
  }
  return null;
}

function getEnginePaths(options = {}) {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return {
    fls: findBinary('sleuthkit', [`fls${ext}`], options),
    icat: findBinary('sleuthkit', [`icat${ext}`], options),
    istat: findBinary('sleuthkit', [`istat${ext}`], options),
    mmls: findBinary('sleuthkit', [`mmls${ext}`], options),
    photorec: findBinary('testdisk', [`photorec_win${ext}`, `photorec${ext}`], options),
    testdisk: findBinary('testdisk', [`testdisk_win${ext}`, `testdisk${ext}`], options),
    fidentify: findBinary('testdisk', [`fidentify_win${ext}`, `fidentify${ext}`], options),
    ffmpeg: findBinary('ffmpeg', [`ffmpeg${ext}`], options),
    ffprobe: findBinary('ffmpeg', [`ffprobe${ext}`], options),
  };
}

function getEngineCapabilitiesSync(isAdmin) {
  const bins = getEnginePaths(isAdmin !== undefined ? { elevated: Boolean(isAdmin) } : {});
  return {
    isAdmin: Boolean(isAdmin),
    sleuthkit: Boolean(bins.fls && bins.icat),
    mmls: Boolean(bins.mmls),
    photorec: Boolean(bins.photorec),
    // Built-in pure-Node signature + container engine backs fidentify even if external binary is absent.
    fidentify: true,
    externalFidentify: Boolean(bins.fidentify),
    ffmpeg: Boolean(bins.ffmpeg),
    ffprobe: Boolean(bins.ffprobe),
  };
}

function checkWindowsIsAdmin() {
  if (process.platform !== 'win32') {
    return Promise.resolve(typeof process.getuid === 'function' ? process.getuid() === 0 : true);
  }
  return new Promise((resolve) => {
    execFile('net.exe', ['session'], { windowsHide: true, timeout: 3000 }, (err) => {
      resolve(!err);
    });
  });
}

function getCurrentUserWindowsSid() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'whoami.exe',
      ['/user', '/fo', 'csv', '/nh'],
      { windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
          return;
        }
        const match = String(stdout).match(/S-1-(?:\d+-)+\d+/);
        resolve(match ? match[0] : null);
      },
    );
  });
}

function execBinaryText(binPath, args, options = {}) {
  return new Promise((resolve) => {
    if (!binPath) {
      resolve({ ok: false, stdout: '', stderr: 'Binary not found' });
      return;
    }
    execFile(
      binPath,
      args,
      {
        windowsHide: true,
        maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
        timeout: options.timeout || 120000,
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: stdout || '',
          stderr: stderr || (err ? err.message : ''),
        });
      },
    );
  });
}

/**
 * Runs Sleuth Kit `mmls` to enumerate MBR/GPT/BSD partitions cleanly.
 */
async function runMmlsPartitions(devicePath, sectorSize = 512) {
  const { mmls } = getEnginePaths();
  if (!mmls) return [];
  const res = await execBinaryText(mmls, ['-B', '-b', String(sectorSize), devicePath], {
    timeout: 15000,
  });
  if (!res.ok || !res.stdout) return [];

  const parts = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    // Typical mmls row: "002:  000:000   0000002048   0001026047   0001024000   NTFS / exFAT (0x07)"
    const m = line.match(
      /^\s*\d+:\s+\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+\S*\s*(.+?)\s*$/,
    );
    if (!m) continue;
    const startLba = Number(m[1]);
    const endLba = Number(m[2]);
    const sectors = Number(m[3]);
    const desc = m[4].trim();
    if (/unallocated|meta|primary table|safety/i.test(desc)) continue;
    const sec = Math.max(512, Number(sectorSize) || 512);
    parts.push({
      startLba,
      endLba,
      sectors,
      startByte: startLba * sec,
      lengthBytes: sectors * sec,
      description: desc,
    });
  }
  return parts;
}

/**
 * Runs Sleuth Kit `fls` recursively in body-file format (`-m /`) for NTFS, FAT, exFAT, ext2/3/4, or HFS+.
 * Returns normalized deleted & active file records with TSK inode IDs for `icat` extraction,
 * attaching `warnings` / `truncatedByLimit` / `partialError` metadata on the returned array.
 */
async function runTskFlsScan(
  devicePath,
  partOffsetBytes,
  fsTypeHint = 'auto',
  includeExisting = true,
  maxEntries = 25000,
  sectorSize = 512,
) {
  const { fls } = getEnginePaths();
  const warnings = [];
  const out = [];
  const attachMeta = (arr, extra = {}) => {
    Object.defineProperties(arr, {
      warnings: { value: warnings, enumerable: false },
      truncatedByLimit: { value: Boolean(extra.truncatedByLimit), enumerable: false },
      partialError: { value: Boolean(extra.partialError), enumerable: false },
    });
    return arr;
  };
  if (!fls) return attachMeta(out);

  const sec = Math.max(512, Number(sectorSize) || 512);
  const sectorOffset = Math.max(0, Math.floor(partOffsetBytes / sec));
  const args = ['-r', '-p', '-m', '/'];
  if (sec !== 512) {
    args.push('-b', String(sec));
  }
  if (!includeExisting) args.push('-d');
  if (sectorOffset > 0) {
    args.push('-o', String(sectorOffset));
  }
  args.push(devicePath);

  const res = await execBinaryText(fls, args, {
    timeout: 60000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!res.ok) {
    const reason = (res.stderr || 'Sleuth Kit fls exited with a non-zero status').trim().split(/\r?\n/)[0];
    warnings.push(`Sleuth Kit fls (${fsTypeHint}) reported an error${res.stdout ? ' (partial output only)' : ''}: ${reason}`);
  }
  if (!res.stdout) return attachMeta(out, { partialError: !res.ok });

  const seen = new Set();
  let truncatedByLimit = false;
  for (const rawLine of res.stdout.split(/\r?\n/)) {
    if (!rawLine) continue;
    if (out.length >= maxEntries) {
      truncatedByLimit = true;
      break;
    }
    // mactime body format: MD5|name|inode|mode|UID|GID|size|atime|mtime|ctime|crtime
    const fields = rawLine.split('|');
    if (fields.length < 11) continue;
    const rawName = fields[1];
    const inode = fields[2].trim();
    const mode = fields[3].trim();
    const size = Number(fields[6]) || 0;
    const mtimeSec = Number(fields[8]) || 0;

    if (!mode.startsWith('r/r') && !mode.startsWith('-/r')) continue;
    if (!inode || !/^[0-9]+(?:-[0-9]+-[0-9]+)?$/.test(inode)) continue;

    const isDeleted = rawName.endsWith(' (deleted)');
    if (!includeExisting && !isDeleted) continue;

    const cleanedPath = (isDeleted ? rawName.slice(0, -' (deleted)'.length) : rawName).replace(/^\//, '');
    if (!cleanedPath || cleanedPath.startsWith('$')) continue;
    const filename = path.posix.basename(cleanedPath);
    if (!filename || filename.startsWith('$')) continue;

    const dedupeKey = `${inode}:${cleanedPath}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const ext = path.extname(filename).replace(/^\./, '').toLowerCase() || 'bin';
    out.push({
      id: `tsk-${sectorOffset}-${inode}-${out.length}`,
      filename,
      extension: ext,
      size,
      status: size > 0 ? 'OK' : 'HEADER_ONLY',
      sourceKind: 'ntfs-mft',
      partitionId: partOffsetBytes > 0 ? `tsk-${sectorOffset}` : 'tsk-root',
      partitionName: `${fsTypeHint.toUpperCase()} (TSK)`,
      originalPath: `\\${cleanedPath.replace(/\//g, '\\')}`,
      offset: partOffsetBytes,
      tskInode: inode,
      tskOffset: partOffsetBytes,
      modifiedAtMs: mtimeSec > 0 ? mtimeSec * 1000 : undefined,
      isDeleted,
      scanPhase: 'quick',
      details: `Sleuth Kit ${fsTypeHint.toUpperCase()} inode ${inode}${isDeleted ? ' (deleted)' : ' (existing)'}`,
    });
  }
  if (truncatedByLimit) {
    warnings.push(`Sleuth Kit fls reached the ${maxEntries.toLocaleString()} entry safety limit on ${fsTypeHint}.`);
  }
  return attachMeta(out, { truncatedByLimit, partialError: !res.ok });
}

/**
 * Extracts a single TSK inode directly to a destination path using `icat`.
 * Verifies destination stream errors and expected byte length when supplied.
 */
function extractTskInodeToFile(devicePath, partOffsetBytes, inode, destPath, expectedSize = 0, sectorSize = 512) {
  return new Promise((resolve) => {
    const { icat } = getEnginePaths();
    if (!icat || !/^[0-9]+(?:-[0-9]+-[0-9]+)?$/.test(String(inode))) {
      resolve({ ok: false, bytesWritten: 0, error: 'TSK icat binary unavailable or invalid inode.' });
      return;
    }
    const sec = Math.max(512, Number(sectorSize) || 512);
    const sectorOffset = Math.max(0, Math.floor((partOffsetBytes || 0) / sec));
    const args = [];
    if (sec !== 512) args.push('-b', String(sec));
    if (sectorOffset > 0) args.push('-o', String(sectorOffset));
    args.push('-r', devicePath, String(inode));

    const outStream = fs.createWriteStream(destPath);
    const child = spawn(icat, args, { windowsHide: true });
    let bytesWritten = 0;
    let errText = '';
    let childCode = null;
    let childClosed = false;
    let streamFinished = false;
    let streamError = null;
    let settled = false;

    const finishOnce = () => {
      if (settled) return;
      if (streamError) {
        settled = true;
        resolve({
          ok: false,
          bytesWritten,
          error: `Destination write failed: ${streamError.message}`,
        });
        return;
      }
      if (!childClosed || !streamFinished) return;
      settled = true;
      const expected = Number.isFinite(Number(expectedSize)) ? Math.max(0, Number(expectedSize)) : 0;
      const shortWrite = expected > 0 && bytesWritten < expected;
      const oversizedWrite = expected > 0 && bytesWritten > expected;
      const emptyWrite = bytesWritten <= 0;
      const ok = childCode === 0 && !emptyWrite && !shortWrite && !oversizedWrite;
      let error;
      if (childCode !== 0) {
        error = errText.trim() || `icat exited with code ${childCode}`;
      } else if (emptyWrite) {
        error = 'Sleuth Kit icat extracted 0 bytes.';
      } else if (shortWrite) {
        error = `Short TSK extraction: wrote ${bytesWritten} of ${expected} expected bytes.`;
      } else if (oversizedWrite) {
        error = `Unexpected oversized TSK extraction: wrote ${bytesWritten} of ${expected} expected bytes.`;
      }
      resolve({
        ok,
        bytesWritten,
        incomplete: shortWrite,
        error,
      });
    };

    child.stdout.on('data', (chunk) => {
      bytesWritten += chunk.length;
    });
    child.stdout.pipe(outStream);
    child.stderr.on('data', (chunk) => {
      errText += chunk.toString('utf8');
    });
    outStream.on('error', (err) => {
      streamError = err;
      try {
        child.kill();
      } catch {
        // ignore
      }
      finishOnce();
    });
    outStream.on('finish', () => {
      streamFinished = true;
      finishOnce();
    });
    child.on('error', (err) => {
      streamError = streamError || err;
      outStream.destroy();
      finishOnce();
    });
    child.on('close', (code) => {
      childCode = code;
      childClosed = true;
      if (!streamError && !streamFinished) {
        outStream.end();
      }
      finishOnce();
    });
  });
}

/**
 * Reads bounded bytes from a TSK inode for in-app preview / header identification.
 */
function readTskInodeHead(devicePath, partOffsetBytes, inode, maxBytes = 256 * 1024, sectorSize = 512) {
  return new Promise((resolve) => {
    const { icat } = getEnginePaths();
    if (!icat || !/^[0-9]+(?:-[0-9]+-[0-9]+)?$/.test(String(inode))) {
      resolve(null);
      return;
    }
    const sec = Math.max(512, Number(sectorSize) || 512);
    const sectorOffset = Math.max(0, Math.floor((partOffsetBytes || 0) / sec));
    const args = [];
    if (sec !== 512) args.push('-b', String(sec));
    if (sectorOffset > 0) args.push('-o', String(sectorOffset));
    args.push('-r', devicePath, String(inode));

    const child = spawn(icat, args, { windowsHide: true });
    const chunks = [];
    let collected = 0;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
    };

    child.stdout.on('data', (chunk) => {
      if (done) return;
      const need = maxBytes - collected;
      if (need <= 0) {
        child.kill();
        finish();
        return;
      }
      const slice = chunk.length > need ? chunk.subarray(0, need) : chunk;
      chunks.push(slice);
      collected += slice.length;
      if (collected >= maxBytes) {
        child.kill();
        finish();
      }
    });
    child.on('close', finish);
    child.on('error', finish);
  });
}

function identifyZipContainerHeadCjs(buf) {
  const ascii = buf.toString('latin1', 0, Math.min(buf.length, 32768));
  if (ascii.includes('word/')) return 'docx';
  if (ascii.includes('xl/')) return 'xlsx';
  if (ascii.includes('ppt/')) return 'pptx';
  if (ascii.includes('AndroidManifest.xml') || ascii.includes('classes.dex')) return 'apk';
  if (ascii.includes('META-INF/MANIFEST.MF')) return 'jar';
  if (ascii.includes('application/epub+zip') || ascii.includes('OEBPS/')) return 'epub';
  if (ascii.includes('application/vnd.oasis.opendocument.text')) return 'odt';
  if (ascii.includes('application/vnd.oasis.opendocument.spreadsheet')) return 'ods';
  if (ascii.includes('application/vnd.oasis.opendocument.presentation')) return 'odp';
  if (ascii.includes('application/x-krita')) return 'kra';
  if (ascii.includes('image/openraster')) return 'ora';
  if (ascii.includes('doc.kml')) return 'kmz';
  if (ascii.includes('FixedDocumentSequence.fdseq')) return 'xps';
  if (ascii.includes('[Content_Types].xml')) return 'docx';
  return 'zip';
}

function identifyOle2ContainerHeadCjs(buf) {
  const scanLen = Math.min(buf.length, 65536);
  // UTF-16LE directory stream markers commonly found inside OLE2 CFBF containers
  const text16 = buf.toString('utf16le', 0, scanLen);
  if (text16.includes('__substg1.0') || text16.includes('__properties_version1.0')) return 'msg';
  if (text16.includes('WordDocument')) return 'doc';
  if (text16.includes('Workbook') || text16.includes('Book')) return 'xls';
  if (text16.includes('PowerPoint Document') || text16.includes('Current User')) return 'ppt';
  if (text16.includes('Quill')) return 'pub';
  if (text16.includes('SummaryInformation') && buf.toString('latin1', 0, scanLen).includes('Windows Installer')) return 'msi';
  return 'doc';
}

function identifyBufferHeadCjs(buf) {
  if (!buf || buf.length < 4) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const b2 = buf[2];
  const b3 = buf[3];

  if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return 'jpg';
  if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) return 'png';
  if (buf.length >= 6 && (buf.toString('ascii', 0, 6) === 'GIF89a' || buf.toString('ascii', 0, 6) === 'GIF87a')) return 'gif';
  if (b0 === 0x42 && b1 === 0x4d && buf.length >= 18 && [12, 40, 52, 56, 108, 124].includes(buf.readUInt32LE(14))) return 'bmp';
  if (b0 === 0x38 && b1 === 0x42 && b2 === 0x50 && b3 === 0x53 && buf.length >= 6) {
    return buf.readUInt16BE(4) === 2 ? 'psb' : 'psd';
  }
  if (b0 === 0x76 && b1 === 0x2f && b2 === 0x31 && b3 === 0x01) return 'exr';
  if (b0 === 0x44 && b1 === 0x44 && b2 === 0x53 && b3 === 0x20) return 'dds';
  if (buf.length >= 16 && buf.toString('ascii', 0, 16) === 'FUJIFILMCCD-RAW ') return 'raf';
  if (buf.length >= 8 && buf[0] === 0 && b1 === 0 && b2 === 1 && b3 === 0) return 'ico';

  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return 'pdf';
  if (b0 === 0x50 && b1 === 0x4b && b2 === 0x03 && b3 === 0x04) return identifyZipContainerHeadCjs(buf);
  if (b0 === 0xd0 && b1 === 0xcf && b2 === 0x11 && b3 === 0xe0) return identifyOle2ContainerHeadCjs(buf);

  if (buf.length >= 16 && buf.toString('ascii', 0, 15) === 'SQLite format 3') return 'sqlite';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === '!BDN') {
    const magic2 = buf.toString('ascii', 8, 10);
    if (magic2 === 'SM' || magic2 === 'SO') return magic2 === 'SO' ? 'ost' : 'pst';
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFX') {
    if (buf.toString('ascii', 8, 12) === 'Egg!') return 'aep';
    return 'rifx';
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF') {
    const fc = buf.toString('ascii', 8, 12);
    if (fc === 'WAVE') return 'wav';
    if (fc === 'AVI ') return 'avi';
    if (fc === 'WEBP') return 'webp';
    if (fc.startsWith('CDR')) return 'cdr';
    if (fc === 'ACON') return 'ani';
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'FORM') {
    const fc = buf.toString('ascii', 8, 12);
    if (fc === 'AIFF' || fc === 'AIFC') return 'aiff';
  }
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (brand === 'crx ') return 'cr3';
    if (brand.toLowerCase().startsWith('qt')) return 'mov';
    if (brand === 'M4A ') return 'm4a';
    if (brand === 'M4B ') return 'm4b';
    if (brand === 'M4V ') return 'm4v';
    if (brand.startsWith('3gp')) return '3gp';
    if (brand.startsWith('3g2')) return '3g2';
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (brand === 'heic' || brand === 'mif1' || brand === 'heix') return 'heic';
    return 'mp4';
  }
  if (b0 === 0x1a && b1 === 0x45 && b2 === 0xdf && b3 === 0xa3) {
    return buf.toString('latin1', 0, Math.min(buf.length, 64)).includes('webm') ? 'webm' : 'mkv';
  }
  if (b0 === 0x30 && b1 === 0x26 && b2 === 0xb2 && b3 === 0x75) return 'wmv';
  if (b0 === 0x46 && b1 === 0x4c && b2 === 0x56 && b3 === 0x01) return 'flv';
  if (buf.length >= 16 && b0 === 0x06 && b1 === 0x0e && b2 === 0x2b && b3 === 0x34) return 'mxf';
  if (b0 === 0x49 && b1 === 0x44 && b2 === 0x33) return 'mp3';
  if (buf.toString('ascii', 0, 4) === 'fLaC') return 'flac';
  if (buf.toString('ascii', 0, 4) === 'OggS') {
    return buf.toString('latin1', 0, Math.min(buf.length, 64)).includes('OpusHead') ? 'opus' : 'ogg';
  }
  if (buf.toString('ascii', 0, 4) === 'MThd') return 'mid';
  if (b0 === 0x52 && b1 === 0x61 && b2 === 0x72 && b3 === 0x21) return 'rar';
  if (buf.length >= 6 && b0 === 0x37 && b1 === 0x7a && b2 === 0xbc && b3 === 0xaf) return '7z';
  if (b0 === 0x1f && b1 === 0x8b && b2 === 0x08) return 'gz';
  if (b0 === 0x42 && b1 === 0x5a && b2 === 0x68) return 'bz2';
  if (buf.length >= 6 && b0 === 0xfd && b1 === 0x37 && b2 === 0x7a && b3 === 0x58 && buf[4] === 0x5a) return 'xz';
  if (b0 === 0x28 && b1 === 0xb5 && b2 === 0x2f && b3 === 0xfd) return 'zst';
  if (b0 === 0x04 && b1 === 0x22 && b2 === 0x4d && b3 === 0x18) return 'lz4';
  if (b0 === 0x4d && b1 === 0x53 && b2 === 0x43 && b3 === 0x46) return 'cab';
  if (buf.length >= 265 && buf.toString('ascii', 257, 262) === 'ustar') return 'tar';
  if (buf.length >= 7 && buf.toString('ascii', 0, 7) === 'BLENDER') return 'blend';
  if (b0 === 0x67 && b1 === 0x6c && b2 === 0x54 && b3 === 0x46) return 'glb';
  if (buf.length >= 6 && /^AC10\d\d$/.test(buf.toString('ascii', 0, 6))) return 'dwg';
  if (buf.length >= 8 && (buf.toString('ascii', 0, 7) === 'RPA-3.0' || buf.toString('ascii', 0, 7) === 'RPA-2.0')) return 'rpa';
  if (buf.length >= 10 && buf.toString('ascii', 0, 10) === 'RENPY RPC2') return 'rpyc';
  if (buf.length >= 8 && buf.toString('ascii', 0, 8) === 'ElfFile\0') return 'evtx';
  if (b0 === 0x4c && b1 === 0x00 && b2 === 0x00 && b3 === 0x00 && buf.length >= 20 && buf[4] === 0x01 && buf[5] === 0x14) return 'lnk';
  if (b0 === 0x0a && b1 === 0x0d && b2 === 0x0d && b3 === 0x0a) return 'pcapng';
  if ((b0 === 0xd4 && b1 === 0xc3 && b2 === 0xb2 && b3 === 0xa1) || (b0 === 0xa1 && b1 === 0xb2 && b2 === 0xc3 && b3 === 0xd4)) return 'pcap';
  if (b0 === 0x03 && b1 === 0xd9 && b2 === 0xa2 && b3 === 0x9a) return 'kdbx';
  if (b0 === 0x00 && b1 === 0x61 && b2 === 0x73 && b3 === 0x6d) return 'wasm';
  if (b0 === 0xca && b1 === 0xfe && b2 === 0xba && b3 === 0xbe) return 'class';
  if (buf.toString('ascii', 0, 4) === 'OTTO') return 'otf';
  if (buf.toString('ascii', 0, 4) === 'wOFF') return 'woff';
  if (buf.toString('ascii', 0, 4) === 'wOF2') return 'woff2';
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '{\\rtf') return 'rtf';
  if (buf.length >= 16 && (buf.toString('ascii', 0, 4) === 'II*\0' || buf.toString('ascii', 0, 4) === 'MM\0*')) return 'tif';
  if (b0 === 0x4d && b1 === 0x5a) return 'exe';

  // Structured text / XML / SVG / AEPX / JSON / Ren'Py fallback
  const headText = buf.toString('utf8', 0, Math.min(buf.length, 4096)).trimStart();
  if (headText.startsWith('{') || headText.startsWith('[')) {
    if (/^\s*[\[{]/.test(headText) && !/[\x00-\x08\x0e-\x1f]/.test(headText.slice(0, 256))) return 'json';
  }
  if (headText.startsWith('<?xml') || headText.startsWith('<')) {
    if (headText.includes('<AfterEffectsProject')) return 'aepx';
    if (headText.includes('<svg')) return 'svg';
    if (/^<!doctype\s+html|^<html/i.test(headText)) return 'html';
    if (/^<\?xml|^<[A-Za-z_][\w:.-]*/.test(headText)) return 'xml';
  }
  if (/^(init\s+(-\d+\s+)?python:|label\s+[A-Za-z_]\w*:|define\s+[A-Za-z_])/m.test(headText)) return 'rpy';
  return null;
}

/**
 * Identifies extensionless/corrupted files using bundled `fidentify_win.exe` (when present)
 * with built-in pure-Node deep header + OOXML/ODF/OLE2/RIFF/ISO-BMFF fallback so it works 100% offline.
 */
async function runFidentifyPaths(filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return {};
  const { fidentify } = getEnginePaths();
  const map = {};

  for (const fp of filePaths.slice(0, 128)) {
    if (typeof fp !== 'string' || !fp.trim()) continue;
    let detected = null;

    if (fidentify) {
      const res = await execBinaryText(fidentify, [fp], { timeout: 6000 });
      if (res.ok && res.stdout) {
        const m = res.stdout.trim().match(/:\s*([a-zA-Z0-9_+-]+)\s*$/);
        if (m && m[1] && m[1].toLowerCase() !== 'unknown') {
          detected = m[1].toLowerCase();
        }
      }
    }

    if (!detected || detected === 'zip' || detected === 'doc' || detected === 'tif') {
      try {
        const fd = fs.openSync(fp, 'r');
        try {
          const headBuf = Buffer.allocUnsafe(65536);
          const n = fs.readSync(fd, headBuf, 0, 65536, 0);
          if (n > 0) {
            const nativeGuess = identifyBufferHeadCjs(headBuf.subarray(0, n));
            if (nativeGuess) detected = nativeGuess;
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        // ignore unreadable path
      }
    }

    if (detected && detected !== 'unknown') {
      map[fp] = detected;
    }
  }
  return map;
}

/**
 * Decodes a single thumbnail frame & codec metadata from a file or bounded buffer via bundled `ffmpeg`.
 */
async function probeVideoFrameWithFfmpeg(inputSource) {
  const { ffmpeg, ffprobe } = getEnginePaths();
  if (!ffmpeg) return null;

  let tempFile = null;
  let targetPath = inputSource.filePath || null;

  try {
    if (!targetPath && inputSource.buffer && inputSource.buffer.length > 0) {
      tempFile = path.join(os.tmpdir(), `td_vid_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.bin`);
      fs.writeFileSync(tempFile, Buffer.from(inputSource.buffer));
      targetPath = tempFile;
    }
    if (!targetPath || !fs.existsSync(targetPath)) return null;

    let width = null;
    let height = null;
    let codec = null;
    let durationSec = null;

    if (ffprobe) {
      const probeRes = await execBinaryText(
        ffprobe,
        [
          '-v', 'error',
          '-select_streams', 'v:0',
          '-show_entries', 'stream=codec_name,width,height:format=duration',
          '-of', 'json',
          targetPath,
        ],
        { timeout: 8000 },
      );
      if (probeRes.ok && probeRes.stdout) {
        try {
          const parsed = JSON.parse(probeRes.stdout);
          const stream = parsed.streams && parsed.streams[0];
          if (stream) {
            codec = stream.codec_name || null;
            width = Number(stream.width) || null;
            height = Number(stream.height) || null;
          }
          if (parsed.format && parsed.format.duration) {
            const d = Number(parsed.format.duration);
            if (Number.isFinite(d) && d > 0) durationSec = d;
          }
        } catch {
          // ignore probe parse failure
        }
      }
    }

    const thumbBytes = await new Promise((resolve) => {
      const child = spawn(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel', 'error',
          '-err_detect', 'ignore_err',
          '-i', targetPath,
          '-frames:v', '1',
          '-vf', 'scale=480:-2',
          '-f', 'image2pipe',
          '-vcodec', 'mjpeg',
          'pipe:1',
        ],
        { windowsHide: true },
      );
      const chunks = [];
      let total = 0;
      const timer = setTimeout(() => {
        child.kill();
      }, 9000);

      child.stdout.on('data', (c) => {
        if (total < 2 * 1024 * 1024) {
          chunks.push(c);
          total += c.length;
        }
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });

    if (!thumbBytes && !codec) return null;
    return {
      thumbnailDataUrl: thumbBytes ? `data:image/jpeg;base64,${thumbBytes.toString('base64')}` : undefined,
      codec,
      width,
      height,
      durationSec,
    };
  } finally {
    if (tempFile && fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // ignore cleanup error
      }
    }
  }
}

/**
 * Multi-tier FFmpeg repair escalation:
 * - Tier 1: Timestamp reconstruction + corrupt packet discard (`-fflags +genpts+igndts+discardcorrupt -err_detect ignore_err -c copy`)
 * - Tier 2: Elementary H.264 / HEVC Annex-B bitstream extraction & clean container remux (MP4/MOV/M4V/3GP)
 * - Tier 3 (allowTranscode): Error-tolerant decode & salvage re-encode (video libx264/aac or still-image frame rescue)
 */
async function ffmpegRepairVideoFile(srcPath, dstPath, options = {}) {
  const { ffmpeg } = getEnginePaths();
  if (!ffmpeg || !srcPath || !fs.existsSync(srcPath)) {
    return { ok: false, tier: 'none', note: 'FFmpeg unavailable or source missing' };
  }

  const ext = String(options.extension || path.extname(dstPath).replace(/^\./, '') || 'mp4')
    .toLowerCase()
    .replace(/^\./, '');
  const isMp4Family = ['mp4', 'mov', 'm4v', '3gp'].includes(ext);
  const isImage = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff'].includes(ext);
  const isRawImage = ['cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2'].includes(ext);
  const isAudio = ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg'].includes(ext);

  const validOut = (p) => fs.existsSync(p) && fs.statSync(p).size > 0;

  if (!isImage && !isRawImage) {
    // Tier 1: Stream copy with timestamp/PTS repair & corrupt packet discard
    const tier1Args = [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-fflags', '+genpts+igndts+discardcorrupt',
      '-err_detect', 'ignore_err',
      '-i', srcPath,
      '-c', 'copy',
    ];
    if (isMp4Family) tier1Args.push('-movflags', '+faststart');
    tier1Args.push(dstPath);

    const t1 = await execBinaryText(ffmpeg, tier1Args, { timeout: 60000 });
    if (t1.ok && validOut(dstPath)) {
      return {
        ok: true,
        tier: 'tier1-remux',
        note: `FFmpeg Tier 1 lossless remux rebuilt ${ext.toUpperCase()} timestamps & container index.`,
      };
    }

    // Tier 2: Elementary bitstream extraction & clean MP4 remux (H.264 -> HEVC), preserving audio if possible
    if (isMp4Family) {
      for (const bsf of [
        { filter: 'h264_mp4toannexb', rawExt: 'h264', label: 'H.264' },
        { filter: 'hevc_mp4toannexb', rawExt: 'h265', label: 'HEVC' },
      ]) {
        const tmpRaw = `${dstPath}.es.${bsf.rawExt}`;
        try {
          const extRes = await execBinaryText(
            ffmpeg,
            [
              '-y',
              '-hide_banner',
              '-loglevel', 'error',
              '-err_detect', 'ignore_err',
              '-i', srcPath,
              '-c:v', 'copy',
              '-bsf:v', bsf.filter,
              '-an',
              tmpRaw,
            ],
            { timeout: 60000 },
          );
          if (extRes.ok && validOut(tmpRaw)) {
            // 2A: Attempt clean remux merging Annex-B video + salvageable original audio track
            const remuxWithAudio = await execBinaryText(
              ffmpeg,
              [
                '-y',
                '-hide_banner',
                '-loglevel', 'error',
                '-fflags', '+genpts+igndts+discardcorrupt',
                '-err_detect', 'ignore_err',
                '-i', tmpRaw,
                '-i', srcPath,
                '-map', '0:v:0',
                '-map', '1:a:0',
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-b:a', '160k',
                '-shortest',
                '-movflags', '+faststart',
                dstPath,
              ],
              { timeout: 60000 },
            );
            if (remuxWithAudio.ok && validOut(dstPath)) {
              return {
                ok: true,
                tier: 'tier2-bitstream',
                note: `FFmpeg Tier 2 extracted raw ${bsf.label} Annex-B video + salvaged audio into clean MP4.`,
              };
            }

            // 2B: Video-only clean Annex-B remux fallback
            const remuxRes = await execBinaryText(
              ffmpeg,
              [
                '-y',
                '-hide_banner',
                '-loglevel', 'error',
                '-fflags', '+genpts',
                '-i', tmpRaw,
                '-c:v', 'copy',
                '-movflags', '+faststart',
                dstPath,
              ],
              { timeout: 60000 },
            );
            if (remuxRes.ok && validOut(dstPath)) {
              return {
                ok: true,
                tier: 'tier2-bitstream',
                note: `FFmpeg Tier 2 extracted raw ${bsf.label} Annex-B stream and rebuilt clean MP4 container.`,
              };
            }
          }
        } finally {
          if (fs.existsSync(tmpRaw)) {
            try {
              fs.unlinkSync(tmpRaw);
            } catch {
              // ignore cleanup
            }
          }
        }
      }
    }
  }

  // Tier 3: Salvage decode & re-encode fallback (requested explicitly via UI toggle)
  if (options.allowTranscode) {
    if (isImage) {
      const imgRes = await execBinaryText(
        ffmpeg,
        [
          '-y',
          '-hide_banner',
          '-loglevel', 'error',
          '-err_detect', 'ignore_err',
          '-i', srcPath,
          '-frames:v', '1',
          dstPath,
        ],
        { timeout: 30000 },
      );
      if (imgRes.ok && validOut(dstPath)) {
        return {
          ok: true,
          tier: 'tier3-salvage',
          note: `FFmpeg Tier 3 error-tolerant decode rebuilt damaged ${ext.toUpperCase()} image.`,
        };
      }
    } else if (isAudio) {
      const audRes = await execBinaryText(
        ffmpeg,
        [
          '-y',
          '-hide_banner',
          '-loglevel', 'error',
          '-err_detect', 'ignore_err',
          '-i', srcPath,
          dstPath,
        ],
        { timeout: 60000 },
      );
      if (audRes.ok && validOut(dstPath)) {
        return {
          ok: true,
          tier: 'tier3-salvage',
          note: `FFmpeg Tier 3 salvage re-encoded damaged ${ext.toUpperCase()} audio stream.`,
        };
      }
    } else {
      const vidArgs = [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-fflags', '+genpts+igndts+discardcorrupt',
        '-err_detect', 'ignore_err',
        '-i', srcPath,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '21',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '160k',
        '-max_muxing_queue_size', '4096',
      ];
      if (isMp4Family) vidArgs.push('-movflags', '+faststart');
      vidArgs.push(dstPath);

      const t3 = await execBinaryText(ffmpeg, vidArgs, { timeout: 180000 });
      if (t3.ok && validOut(dstPath)) {
        return {
          ok: true,
          tier: 'tier3-salvage',
          note: `FFmpeg Tier 3 salvage decode re-encoded playable ${ext.toUpperCase()} stream.`,
        };
      }
    }
  }

  return { ok: false, tier: 'none', note: 'FFmpeg could not reconstruct a valid stream.' };
}

module.exports = {
  isProcessElevatedSync,
  getCandidateEngineDirs,
  findBinary,
  getEnginePaths,
  getEngineCapabilitiesSync,
  checkWindowsIsAdmin,
  getCurrentUserWindowsSid,
  runMmlsPartitions,
  runTskFlsScan,
  extractTskInodeToFile,
  readTskInodeHead,
  identifyBufferHeadCjs,
  runFidentifyPaths,
  probeVideoFrameWithFfmpeg,
  ffmpegRepairVideoFile,
};
