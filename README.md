# TestDisk & PhotoRec

A Windows desktop and offline data recovery application built with React, TypeScript, and Electron. It combines **TestDisk** partition rescue and filesystem metadata parsing (`NTFS`, `FAT32`, `exFAT`) with **PhotoRec** signature carving, unknown-file identification (`fidentify`), and structural repair for photos, videos, documents, and archives.

---

## Features

- **Location-First Start Screen**: Choose directly between connected Windows **External / Internal Drives**, **SD Cards**, **Recycle Bin**, **Desktop**, **Select Folder**, **Raw Disk Image** (`.img`, `.dd`, `.raw`, `.iso`, `.bin`, `.dmg`), or **Unknown File (`fidentify`)**.
- **Deep Filesystem & Signature Recovery**:
  - **MBR & GPT Partition Rescue**: Detects active and deleted/unmapped partitions (`NTFS`, `FAT12/16/32`, `exFAT`), flags BitLocker (`-FVE-FS-`) encrypted volumes, and restores lost partition entries back to MBR or exports repaired `.img` files.
  - **Filesystem Reconstruction**: Parses Windows `$Recycle.Bin` (`$I`/`$R` pairs with original filenames & deletion timestamps), NTFS `$MFT` records, and FAT32 Long File Names / exFAT directory trees.
  - **Streaming Large-File Support**: Reads Windows physical drives (`\\.\PhysicalDriveN`) in chunks with Pause, Resume, and Stop controls, and writes recovered files (including multi-GB `.mp4`/`.mov` videos) directly to disk without buffering entire videos in memory.
- **3-Pane Recovery Explorer**:
  - Switch between **Path** (volume & directory hierarchy) and **Type** (`Pictures`, `Videos`, `Documents`, `Audio`, `Archives`, `Others`) trees.
  - List and thumbnail grid views, live search, block-size / format / status / size / recovery-health filters, and duplicate hiding.
  - Right-hand inspector with image/video preview, recovery-health score, and on-demand sector hex inspection.
- **Built-In File Repair & Forensic Exports**:
  - Repairs truncated `.mp4` / `.mov` / `.m4v` (`mdat` atom patching), `.jpg` (`EOI`), `.png` (`IEND`), and `.zip` central directories on save.
  - Exports/reloads `.tdscan.json` scan sessions and **DFXML** forensic inventories.

---

## How to Get the Portable ZIP File onto Your Desktop

You can either download the ready-to-run Windows ZIP built automatically by GitHub Actions, or build it locally on Windows and copy it straight to your Desktop.

### Option 1: Download from GitHub onto Your Desktop (No Build Tools Needed)

This repository includes a GitHub Actions workflow (`.github/workflows/build-windows.yml`) that compiles the Windows portable package (`TestDisk-PhotoRec-Windows-Portable.zip`).

1. Open your repository on **GitHub**.
   - **If you pushed a release tag** (e.g. `v7.2.0`): open the **Releases** page on the right sidebar and download **`TestDisk-PhotoRec-Windows-Portable.zip`**.
   - **If you pushed to `main` / `master` or ran the workflow manually**:
     1. Click the **Actions** tab at the top of your GitHub repository.
     2. Select **Build Windows Portable ZIP** in the left sidebar (if no run exists yet, click **Run workflow**).
     3. Open the latest green completed workflow run and scroll down to **Artifacts**.
     4. Click **`TestDisk-PhotoRec-Windows-Portable`** to download it.
2. When your browser asks where to save (or after downloading into `Downloads`):
   - Move **`TestDisk-PhotoRec-Windows-Portable.zip`** onto your **Desktop** (`C:\Users\<YourName>\Desktop\`), or drag it from your browser/Downloads folder onto the Desktop.
   - *(Note: GitHub Actions Artifacts wrap files in an archive download, so if opening the downloaded zip reveals another `TestDisk-PhotoRec-Windows-Portable.zip` inside it, drag that inner file or extract it straight onto your Desktop.)*

### Option 2: Build the ZIP Locally and Copy to Your Desktop (Windows PowerShell)

If you have **Node.js 20+** installed on Windows:

1. Open **PowerShell** inside the project directory.
2. Install dependencies and build the Windows x64 ZIP + portable `.exe`:
   ```powershell
   npm ci
   npm install --no-save electron electron-builder
   npm run dist:win
   ```
3. Copy the generated ZIP file straight onto your Windows **Desktop**:
   ```powershell
   Copy-Item "release\*.zip" "$env:USERPROFILE\Desktop\TestDisk-PhotoRec-Windows-Portable.zip"
   ```
   *(The `release\` folder also contains the standalone portable `.exe` if you prefer copying just the executable.)*

---

## Extract & Run on Windows

1. Right-click **`TestDisk-PhotoRec-Windows-Portable.zip`** on your **Desktop** and choose **Extract All...** to unpack it into a Desktop folder.
2. Open the extracted folder and double-click **`TestDisk-PhotoRec.exe`**.
   - Windows will prompt for Administrator permission (`requireAdministrator`) so the app can read `$Recycle.Bin` and physical drives (`\\.\PhysicalDriveN`) directly.
3. From the start screen (**Select a location to search for lost data**), choose **Recycle Bin**, **Desktop**, **Select Folder**, **Disk Image**, or a connected drive.
4. Check the `.jpeg`, `.mp4`, or other files you want to restore, click **Recover** (or **Recover All ...**), choose a **Local** destination folder (recommended for large video files) or **Portable ZIP**, optionally toggle **Enable file repair**, and click **Save**.

> **Safety Tip**: When recovering deleted files from a drive or partition, always save the recovered output to a **different drive or folder** than the one you are scanning to avoid overwriting unallocated clusters.

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

## License

Licensed under the GNU General Public License (GPL), matching upstream TestDisk & PhotoRec.

