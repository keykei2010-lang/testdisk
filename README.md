# Disk & Partition Recovery Explorer

A Windows desktop and offline data recovery application built with React, TypeScript, and Electron. It combines MBR/GPT partition rescue and native filesystem metadata parsing (`NTFS`, `FAT12/16/32`, `exFAT`) with raw sector signature carving, unknown-file binary identification, and structural repair for photos, videos, documents, and archives.

---

## Features

- **Location-First Start Screen**: Choose directly between connected Windows **External / Internal Drives**, **SD Cards**, **Recycle Bin**, **Desktop**, **Select Folder**, **Raw Disk Image** (`.img`, `.dd`, `.raw`, `.iso`, `.bin`, `.dmg`), or **Unknown File Inspector**.
- **Deep Filesystem & Signature Recovery**:
  - **MBR & GPT Partition Rescue**: Detects active and deleted/unmapped partitions (`NTFS`, `FAT12/16/32`, `exFAT`, `ext4`), flags BitLocker (`-FVE-FS-`) encrypted volumes for Windows unlock, and restores lost partition entries back to MBR on full in-memory `.img` files (safely blocking MBR writes on EFI GPT disks).
  - **Filesystem Reconstruction**: Parses Windows `$Recycle.Bin` (`$I`/`$R` pairs with original filenames & deletion timestamps), NTFS `$MFT` records (including `$ATTRIBUTE_LIST`, 4K alignment, compression/EFS detection, and `$Bitmap` overwrite checks), `$UsnJrnl`, Volume Shadow Copies (`vssadmin`), and FAT32 LFN / exFAT directory trees.
  - **Streaming Large-File Support**: Reads Windows physical drives (`\\.\PhysicalDriveN`) with sector-aligned I/O, automatic bad-sector retry/skip telemetry, Pause/Resume/Stop controls, and direct disk streaming for multi-GB videos.
- **3-Pane Recovery Explorer**:
  - Switch between **Path** (volume & directory hierarchy) and **Type** (`Pictures`, `Videos`, `Documents`, `Audio`, `Archives`, `Others`) trees.
  - List and thumbnail grid views, live search, block-size / format / status / size / recovery-health filters, and duplicate hiding.
  - Right-hand inspector with image/video preview, recovery-health score, BitLocker unlock controls, and on-demand sector hex inspection.
- **Built-In Structural File Repair & Forensic Exports**:
  - Repairs truncated `.mp4` / `.mov` / `.m4v` (`mdat` / `moov` atom reconstruction), `.jpg`, `.png`, `.avi`, `.mkv`, `.webm`, `.pdf`, `.docx`/`.xlsx`/`.pptx`/`.zip`, `.psd`, `.pst`/`.ost`, `.sqlite`, `.aep`/`.aepx`, `.rtf`, `.json`, and `.rpy`.
  - Exports/reloads `.tdscan.json` scan sessions and **DFXML** forensic inventories.

---

## Important Recovery Safety & Limitations

- **SSD / NVMe TRIM Advisory**: Internal and USB-UASP SSDs with hardware TRIM / Discard enabled typically zero out unallocated blocks almost immediately after file deletion or Recycle Bin emptying. If a file disappeared after TRIM ran, deleted sectors may contain zeros (`0x00`), leaving raw sector carving unable to recover deleted payloads unless Volume Shadow Copies (`vssadmin`) or intact `$MFT` copies remain.
- **Save to a Different Drive**: Always write recovered files, forensic reports (`.csv`, `.dfxml`, `.tdscan.json`), and `Recovery-Audit-Report.txt` to a **different physical drive or volume** than the one being scanned so recovered writes never overwrite unallocated sectors.
- **Administrator & BitLocker**: Accessing physical drives (`\\.\PhysicalDriveN`), raw `$MFT` records, `$UsnJrnl`, and Volume Shadow Copies requires running as Administrator (`requireAdministrator` manifest). BitLocker-encrypted partitions (`-FVE-FS-`) must be unlocked using your 48-digit recovery key or password first.

---

## How to Get the Portable ZIP File onto Your Desktop

### Option 1: Download from GitHub Actions

This repository includes a GitHub Actions workflow (`.github/workflows/build-windows.yml`) that compiles the Windows portable package (`Disk-Partition-Recovery-Explorer-Windows-Portable.zip`).

1. Open your repository on **GitHub**:
   - **Latest Dev Build (`dev-build` pre-release):** Open **Releases** (`releases/tag/dev-build`) and download **`Disk-Partition-Recovery-Explorer-Windows-Portable.zip`**.
   - **Numbered Releases** (e.g. `v1.0.0`): open **Releases** and download **`Disk-Partition-Recovery-Explorer-Windows-Portable.zip`**.
   - **Workflow Artifacts (Actions tab):** Open **Actions** -> **Build Windows Portable ZIP** and download **`Disk-Partition-Recovery-Explorer-Windows-Portable`**.
2. Save or move **`Disk-Partition-Recovery-Explorer-Windows-Portable.zip`** onto your **Desktop** (`C:\Users\<YourName>\Desktop\`).

### Option 2: Build Locally on Windows (PowerShell)

If you have **Node.js 20+** installed on Windows:

1. Open **PowerShell** inside the project directory.
2. Install dependencies, download & SHA-256-verify the optional bundled engines (`Sleuth Kit 4.15.0` & `FFmpeg 9.1`), and build the Windows x64 ZIP + portable `.exe`:
   ```powershell
   npm install
   npm install --no-save electron@45.5.0 electron-builder@26.18.0
   npm run setup:engines
   npm run dist:win
   ```
3. Copy the generated ZIP file straight onto your Windows **Desktop**:
   ```powershell
   Copy-Item "release\*.zip" "$env:USERPROFILE\Desktop\Disk-Partition-Recovery-Explorer-Windows-Portable.zip"
   ```

---

## Extract & Run on Windows

1. Right-click **`Disk-Partition-Recovery-Explorer-Windows-Portable.zip`** on your **Desktop** and choose **Extract All...**.
2. Open the extracted folder and double-click **`Disk-Partition-Recovery-Explorer.exe`**.
   - Unsigned builds may display a **Windows SmartScreen** prompt ("Windows protected your PC" -> **More info** -> **Run anyway**).
   - Windows UAC will prompt for Administrator elevation (`requireAdministrator`) so the app can read `$Recycle.Bin` and raw drives (`\\.\PhysicalDriveN`).
3. Choose **Recycle Bin**, **Desktop**, **Select Folder**, **Disk Image**, or a connected drive, select items to restore, and save to a **different destination drive**.

---

## Development & Testing

```bash
# Start Vite development server (port 3000)
npm run dev

# Run TypeScript type-check & ESLint
npm run lint

# Run recovery engine unit tests
npx tsx --test tests/recoveryEngine.test.ts

# Build web production bundle
npm run build

# Build Electron renderer + Windows portable ZIP/EXE
npm run dist:win
```

## License & Third-Party Notices

- Application source code: GNU General Public License v3 (GPLv3).
- When packaged with optional helper binaries via `scripts/setup-win-engines.ps1` / CI:
  - **The Sleuth Kit** (`fls`, `icat`, `istat`, `mmls`): Common Public License (CPL 1.0) / IBM Public License (IPL 1.0).
  - **FFmpeg / FFprobe** (`ffmpeg`, `ffprobe`): GNU General Public License (GPL) / Lesser General Public License (LGPL).
