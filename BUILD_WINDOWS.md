# Windows Portable EXE & ZIP Build

This repository includes an automated **GitHub Actions** workflow (`.github/workflows/build-windows.yml`) and an **Electron Windows raw-drive bridge** (`electron/main.cjs`) so you can download a ready-to-extract `.zip` containing `TestDisk-PhotoRec.exe` without setting up a build environment manually.

## Option 1: Download Directly From GitHub Actions (Zero Local Setup)
1. Push this repository to GitHub (or open the **Actions** tab on your GitHub repository).
2. Select the **Build Windows Portable ZIP** workflow and click **Run workflow** (it also runs automatically on every push to `main`/`master`).
3. When the job completes, download **`TestDisk-PhotoRec-Windows-Portable`** from the **Artifacts** section.
4. Extract the `.zip` anywhere on Windows (or on a separate USB recovery drive) and double-click **`TestDisk-PhotoRec.exe`**.

## Option 2: Build Locally on Windows
```powershell
npm install
npm install --no-save electron electron-builder
npm run dist:win
```
The portable `.zip` and `.exe` will be created in `release/`.
