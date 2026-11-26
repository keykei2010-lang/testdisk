# Optional External Engine Binaries (`electron/bin`)

The desktop recovery app runs 100% natively without external executables using built-in TypeScript and Node.js engines for:
- NTFS `$MFT` / `$UsnJrnl` / `$Bitmap`, FAT32, exFAT, MBR/GPT parsing
- 150+ signature deep carving & non-contiguous video fragment reassembly
- Structural repair for MP4/MOV/M4V/3GP (`moov`), JPEG/PNG/AVI/RAW previews, and 25+ document/project/database formats
- Built-in pure-Node `fidentify` file type identification (`identifyBufferHeadCjs`)

To also enable optional external engines during packaging (`npm run dist:win`):
- `electron/bin/ffmpeg/` -> `ffmpeg.exe`, `ffprobe.exe` (Tier 1/2/3 remux & salvage decode, H.265/MKV/WEBM frame probing)
- `electron/bin/sleuthkit/` -> `fls.exe`, `icat.exe`, `mmls.exe`, `istat.exe` + runtime DLLs (Linux ext2/3/4 & HFS+ volume browsing)

Run `npm run setup:engines` on Windows to download and stage FFmpeg and Sleuth Kit binaries into `electron/bin/`, or install FFmpeg / Sleuth Kit anywhere on `PATH` (WinGet, Scoop, Chocolatey, or `C:\ffmpeg\bin`).
