# Windows Portable EXE & ZIP Build

This repository includes an automated **GitHub Actions** workflow (`.github/workflows/build-windows.yml`) and an **Electron Windows raw-drive bridge** (`electron/main.cjs`) so you can build or download a ready-to-extract `.zip` containing `Disk-Partition-Recovery-Explorer.exe`.

## Option 1: Download Directly From GitHub Actions (Zero Local Setup)
1. Push this repository to GitHub (or open the **Actions** tab on your GitHub repository).
2. Select the **Build Windows Portable ZIP** workflow and click **Run workflow** (it also runs automatically on every push to `main`/`master`).
3. When the job completes, download **`Disk-Partition-Recovery-Explorer-Windows-Portable`** from the **Artifacts** section.
4. Extract the `.zip` anywhere on Windows (ideally onto a separate USB recovery drive) and double-click **`Disk-Partition-Recovery-Explorer.exe`**.
   - Unsigned portable `.exe` builds will trigger **Windows SmartScreen** ("More info" -> "Run anyway") and a UAC `requireAdministrator` elevation prompt for physical disk access.

## Option 2: Build Locally on Windows
```powershell
npm install
npm install --no-save electron@45.5.0 electron-builder@26.18.0
npm run setup:engines
npm run dist:win
```
The portable `.zip` and `.exe` will be created in `release/`.

