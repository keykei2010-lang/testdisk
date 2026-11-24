const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Resolves bundled C engine binaries (The Sleuth Kit, CGSecurity TestDisk/PhotoRec, FFmpeg)
 * from packaged `process.resourcesPath/engines` or local `electron/bin`.
 */
function resolveEngineRoot() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'engines'));
  }
  candidates.push(path.join(__dirname, 'bin'));
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

function findBinary(subFolder, baseNames) {
  const root = resolveEngineRoot();
  if (root) {
    for (const name of baseNames) {
      const p1 = path.join(root, subFolder, name);
      if (fs.existsSync(p1)) return p1;
      const p2 = path.join(root, name);
      if (fs.existsSync(p2)) return p2;
    }
  }
  return null;
}

function getEnginePaths() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return {
    fls: findBinary('sleuthkit', [`fls${ext}`]),
    icat: findBinary('sleuthkit', [`icat${ext}`]),
    istat: findBinary('sleuthkit', [`istat${ext}`]),
    mmls: findBinary('sleuthkit', [`mmls${ext}`]),
    photorec: findBinary('testdisk', [`photorec_win${ext}`, `photorec${ext}`]),
    testdisk: findBinary('testdisk', [`testdisk_win${ext}`, `testdisk${ext}`]),
    fidentify: findBinary('testdisk', [`fidentify_win${ext}`, `fidentify${ext}`]),
    ffmpeg: findBinary('ffmpeg', [`ffmpeg${ext}`]),
    ffprobe: findBinary('ffmpeg', [`ffprobe${ext}`]),
  };
}

function getEngineCapabilitiesSync(isAdmin) {
  const bins = getEnginePaths();
  return {
    isAdmin: Boolean(isAdmin),
    sleuthkit: Boolean(bins.fls && bins.icat),
    mmls: Boolean(bins.mmls),
    photorec: Boolean(bins.photorec),
    fidentify: Boolean(bins.fidentify),
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
    parts.push({
      startLba,
      endLba,
      sectors,
      startByte: startLba * sectorSize,
      description: desc,
    });
  }
  return parts;
}

/**
 * Runs Sleuth Kit `fls` recursively in body-file format (`-m /`) for NTFS, FAT, exFAT, ext2/3/4, or HFS+.
 * Returns normalized deleted & active file records with TSK inode IDs for `icat` extraction.
 */
async function runTskFlsScan(devicePath, partOffsetBytes, fsTypeHint = 'auto', includeExisting = true, maxEntries = 8000) {
  const { fls } = getEnginePaths();
  if (!fls) return [];

  const sectorOffset = Math.max(0, Math.floor(partOffsetBytes / 512));
  const args = ['-r', '-p', '-m', '/'];
  if (!includeExisting) args.push('-d');
  if (sectorOffset > 0) {
    args.push('-o', String(sectorOffset));
  }
  args.push(devicePath);

  const res = await execBinaryText(fls, args, {
    timeout: 45000,
    maxBuffer: 48 * 1024 * 1024,
  });
  if (!res.stdout) return [];

  const out = [];
  const seen = new Set();
  for (const rawLine of res.stdout.split(/\r?\n/)) {
    if (!rawLine || out.length >= maxEntries) continue;
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
      modifiedAtMs: mtimeSec > 0 ? mtimeSec * 1000 : Date.now(),
      isDeleted,
      scanPhase: 'quick',
      details: `Sleuth Kit ${fsTypeHint.toUpperCase()} inode ${inode}${isDeleted ? ' (deleted)' : ' (existing)'}`,
    });
  }
  return out;
}

/**
 * Extracts a single TSK inode directly to a destination path using `icat`.
 */
function extractTskInodeToFile(devicePath, partOffsetBytes, inode, destPath) {
  return new Promise((resolve) => {
    const { icat } = getEnginePaths();
    if (!icat || !/^[0-9]+(?:-[0-9]+-[0-9]+)?$/.test(String(inode))) {
      resolve({ ok: false, bytesWritten: 0, error: 'TSK icat binary unavailable or invalid inode.' });
      return;
    }
    const sectorOffset = Math.max(0, Math.floor((partOffsetBytes || 0) / 512));
    const args = [];
    if (sectorOffset > 0) args.push('-o', String(sectorOffset));
    args.push('-r', devicePath, String(inode));

    const outStream = fs.createWriteStream(destPath);
    const child = spawn(icat, args, { windowsHide: true });
    let bytesWritten = 0;
    let errText = '';

    child.stdout.on('data', (chunk) => {
      bytesWritten += chunk.length;
    });
    child.stdout.pipe(outStream);
    child.stderr.on('data', (chunk) => {
      errText += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      outStream.destroy();
      resolve({ ok: false, bytesWritten, error: err.message });
    });
    outStream.on('finish', () => {
      // Wait for exit code via closed event or resolve once stream flushed cleanly
    });
    child.on('close', (code) => {
      outStream.end(() => {
        resolve({
          ok: code === 0 && bytesWritten > 0,
          bytesWritten,
          error: code === 0 ? undefined : errText.trim() || `icat exited with code ${code}`,
        });
      });
    });
  });
}

/**
 * Reads bounded bytes from a TSK inode for in-app preview / header identification.
 */
function readTskInodeHead(devicePath, partOffsetBytes, inode, maxBytes = 256 * 1024) {
  return new Promise((resolve) => {
    const { icat } = getEnginePaths();
    if (!icat || !/^[0-9]+(?:-[0-9]+-[0-9]+)?$/.test(String(inode))) {
      resolve(null);
      return;
    }
    const sectorOffset = Math.max(0, Math.floor((partOffsetBytes || 0) / 512));
    const args = [];
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

/**
 * Identifies extensionless/corrupted files using bundled `fidentify_win.exe` (480+ PhotoRec signatures).
 */
async function runFidentifyPaths(filePaths) {
  const { fidentify } = getEnginePaths();
  if (!fidentify || !Array.isArray(filePaths) || filePaths.length === 0) return {};
  const map = {};
  for (const fp of filePaths.slice(0, 64)) {
    const res = await execBinaryText(fidentify, [fp], { timeout: 6000 });
    if (res.ok && res.stdout) {
      // Output line: "<path>: <ext>" or "<path>: unknown"
      const m = res.stdout.trim().match(/:\s*([a-zA-Z0-9_+-]+)\s*$/);
      if (m && m[1] && m[1].toLowerCase() !== 'unknown') {
        map[fp] = m[1].toLowerCase();
      }
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
  const isImage = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'cr2', 'cr3', 'nef', 'arw', 'dng'].includes(ext);
  const isAudio = ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg'].includes(ext);

  const validOut = (p) => fs.existsSync(p) && fs.statSync(p).size > 0;

  if (!isImage) {
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
  getEnginePaths,
  getEngineCapabilitiesSync,
  checkWindowsIsAdmin,
  getCurrentUserWindowsSid,
  runMmlsPartitions,
  runTskFlsScan,
  extractTskInodeToFile,
  readTskInodeHead,
  runFidentifyPaths,
  probeVideoFrameWithFfmpeg,
  ffmpegRepairVideoFile,
};
