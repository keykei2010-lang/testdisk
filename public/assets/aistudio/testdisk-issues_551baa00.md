# keykei2010-lang/testdisk: issues to address

Commit reviewed: 365cfff0. Compiled 2026-11-26 from both reviews.
Basis: static reading of selected code, plus Microsoft docs for Windows behaviour. Nothing was run or reproduced. This is every issue found, not a complete audit. Line numbers are approximate.

## P0: blockers
| # | Issue | Fix | Where |
|---|---|---|---|
| 1 | Raw device reads are not rounded to sectors (NTFS file samples, $Bitmap, 2-36 byte reads while carving). Likely fails on Windows volume handles; whole-disk handles less certain | One sector-aligned reader for every device read; audit all readSync calls | main.cjs ~1274, ~1346; scannerWorker.cjs |
| 2 | NTFS quick scan has no handling around these reads, so one failure can abort it. The saved review found Recycle Bin, Desktop and folder scans share this path when run as admin | Handle errors per record; keep results already found | main.cjs |
| 3 | Scan-thread errors are ignored and the scan can show 100% | Handle error messages and exit codes; show incomplete scans | main.cjs ~2620 |
| 4 | A failed chunk read abandons the rest of that thread's section | Retry smaller reads, skip only bad sectors, log unread ranges | scannerWorker.cjs ~421 |
| 5 | Lost-partition search covers only the first 1 MiB on physical drives and images over 128 MiB; misses the standard sector 2048 | Search the whole disk | App.tsx ~1060; partitions.ts |

## P1: wrong or incomplete results
| # | Issue | Fix |
|---|---|---|
| 6 | About 30 formats/branches use guessed or capped sizes marked complete: files cut off or padded with junk, and can still score well | Parse real file structure; otherwise mark size unknown/partial |
| 7 | Carver skips ahead by the guessed size within the 4 MiB chunk, missing files | Skip only past validated sizes |
| 8 | NTFS quick scan stops at 250,000 records across all partitions (180,000 in another path), with no warning found | Read the whole file table, or report truncation |
| 9 | NTFS attribute lists not handled (some fragmented files) | Support them |
| 10 | NTFS compression and encryption not checked | Decompress or flag as unsupported |
| 11 | Used-space map capped at 8 MiB (256 GiB at 4 KiB clusters); reuse beyond it may go undetected | Load the full map; show unknown when unavailable |
| 12 | Parsing assumes 1,024-byte file records, and partition code assumes 512-byte sectors in places | Read actual sizes; support 4K-sector drives |
| 13 | A save that ends early on a short read can be reported OK | Compare bytes written with expected size |
| 14 | Files with no checksum count as verified, labelled "CRC-verified"; checksum covers at most the first 64 KiB, usually pre-repair | Report not checked / partial check; never imply the file is intact |
| 15 | Some carved files without EXIF dates get an invented date (in-memory image path) | Show unknown |

## P2: safety and missing capability
| # | Issue | Fix |
|---|---|---|
| 16 | "Restore to MBR" only edits memory; for a physical drive the exported "repaired image" is just the first 1 MiB | Remove or relabel; use official TestDisk |
| 17 | Partition writer is MBR only, keeps four entries, and has no GPT handling (could produce a wrong table for GPT disks) | Disable until GPT and MBR are properly tested |
| 18 | Same-drive save guard checks one source only and passes if drive lookup fails | Check every source; block or require explicit confirmation if unknown |
| 19 | Repair on save: no option found to keep the original copy | Keep original and write repaired file separately |
| 20 | No drive imaging or bad-sector retry found; parallel readers may add strain to a failing drive | Add imaging, or warn and direct users to a suitable tool |
| 21 | No TRIM warning found in app or docs | Explain SSD limits before scanning |
| 22 | BitLocker password unlock likely broken (-Password is documented as a prompt) | Fix and test; keep secrets off command lines (recovery key is passed there too) |

## P3: security, build, branding
| # | Issue | Fix |
|---|---|---|
| 23 | Helper programs are searched for in user-writable folders and PATH; risky when run as admin | Run only bundled, verified binaries from a protected location |
| 24 | Downloaded helpers have no checksum checks; FFmpeg uses a moving "latest" build; setup script and CI use different sources | Pin versions and verify hashes |
| 25 | CI continues if a helper download fails | Fail the build |
| 26 | CI uses npm install and installs unpinned Electron and electron-builder | Pin versions, use a lockfile install |
| 27 | README says admin rights are requested automatically; no such setting found | Add it or correct the README |
| 28 | PhotoRec and TestDisk are bundled by CI but never run for recovery | Integrate them, or stop presenting the app as them |
| 29 | Name, version 7.2.x and appId org.cgsecurity.* could be mistaken for the official tool | Rename, use own appId, credit upstream; check licence obligations for bundled binaries |

## P4: testing and documentation
| # | Issue | Fix |
|---|---|---|
| 30 | 27 tests; none load main.cjs or scannerWorker.cjs | Test scanning, saving and error paths |
| 31 | CI runs no tests or lint | Require them (plus type check) before publishing builds |
| 32 | No Windows real-drive evidence seen | Test NTFS, FAT32, exFAT with known hashes; deleted, fragmented, formatted, large, bad-sector cases; compare with official PhotoRec |
| 33 | README claims exceed what the code supports (partition rescue, verification, admin) | Rewrite to match tested behaviour |

## Suggested order
1-4, then 5 and 16-18 (or disable partition features), 6-15, 23-26, the rest. Add tests with each fix.
