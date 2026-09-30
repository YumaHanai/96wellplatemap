# 🧬 96-Well Sample Registry

**Register knock-in cells • Record treatment and fixation • Search wells • Export metadata**

## Overview

96-Well Sample Registry is a Flask web application for recording knock-in cell samples in 96-well plates. This package contains the files needed to run the English interface on Windows using a **Miniconda environment named `plateapp`** and the **Waitress** server.

Features include:

- Excel template download and import.
- Spreadsheet-style editing and a 96-well map.
- Plate metadata: plate name, experimenter, fixation conditions, storage location and eLabFTW experiment ID.
- Search across plates by gene, Gene intron, cell stock or condition.
- Gene and cell-stock label normalization, local MANE reference checks and shared approvals.
- Complete current metadata export to Excel.
- Save history, Trash, restore and permanent deletion.

## Project structure

```text
96wellplatemap_app/
├── README.md
├── environment.yaml                      # Conda environment definition
├── requirements.txt                      # Python package requirements
├── windows_server.py                     # Windows / Waitress launcher
├── MANE.GRCh38.v1.0.summary.txt            # Gene reference
├── MANE.GRCh38.v1.0.refseq_genomic.gtf.gz   # Transcript exon reference
└── plate_app/
    ├── __init__.py
    ├── app.py                            # Application and database routes
    ├── genes.py                          # Label normalization / MANE checks
    ├── workbooks.py                      # Excel import and export
    ├── downloads/
    │   └── 96wellplatemap_template.xlsx
    ├── templates/
    │   └── index.html
    └── static/
        ├── app.css
        ├── sheet.css
        ├── app.js
        ├── registry.js
        └── sheet-tools.js
```

Keep this structure intact. The two MANE files must remain next to `windows_server.py`. They are already included; no additional genome download is required.

The package excludes the old reference application, development tests, screenshots, unused MANE files, virtual environments, experimental databases and session keys. The previous `setup_windows.cmd` and `start_windows.cmd` launchers are not needed for this Conda workflow.

## Installation on a new Windows PC

Install Miniconda on the **local Windows disk** first. Run the following commands in **Anaconda Prompt / Miniconda Prompt**, not a Python interactive console. Internet access is required for the initial package installation.

### 1. Place the application files

Extract the package and place its application folder here:

```text
\\fs24-p04\okamura-lab-imaging\Hanai_app\96wellplatemap_app
```

The final folder should directly contain `windows_server.py`, `environment.yaml` and `plate_app`. Avoid an extra nested `96wellplatemap_app` folder. Keep an existing app copy until the new package has been checked; do not delete experimental data when tidying folders.

### 2. Open the application folder

```bat
pushd "\\fs24-p04\okamura-lab-imaging\Hanai_app\96wellplatemap_app"
```

`pushd` makes the network folder usable as the current directory in the Windows command prompt. It may display a temporary drive letter such as `Z:`; this is normal.

### 3. Create the environment — first time only

```bat
conda env create -f environment.yaml
conda activate plateapp
python --version
python -m pip check
```

The environment definition installs Python 3.12 and pip, then installs Flask, openpyxl and Waitress from `requirements.txt`. Python should report `3.12.x`; `pip check` should report `No broken requirements found.` Dependencies use version ranges, not an exact lock file.

**If `plateapp` already exists and the app is working, do not create it again.** Continue with the startup section below. After replacing the app with a newer package, run:

```bat
conda activate plateapp
pushd "\\fs24-p04\okamura-lab-imaging\Hanai_app\96wellplatemap_app"
python -m pip install -r requirements.txt
python -m pip check
```

### Equivalent manual setup

The following is the manual method used during the original setup. Use either this method or `conda env create`, not both:

```bat
conda create -n plateapp python=3.12
conda activate plateapp
pushd "\\fs24-p04\okamura-lab-imaging\Hanai_app\96wellplatemap_app"
python -m pip install -r requirements.txt
```

## Start the app — each session

Open Anaconda Prompt and run:

```bat
conda activate plateapp
pushd "\\fs24-p04\okamura-lab-imaging\Hanai_app\96wellplatemap_app"
python windows_server.py
```

Keep the prompt window open. On that Windows PC, open Edge or Chrome at:

```text
http://127.0.0.1:5050
```

The `Plate library` screen confirms that the app is running. The terminal prints the database path and browser URL. Stop the server with **Ctrl+C**. It does not restart automatically after Windows restarts or the user signs out.

There is no need to activate a separate `.venv`, run `setup_windows.cmd`, or use `start_windows.cmd`. Conda supplies the Python environment; `windows_server.py` starts the same application with Waitress.

## How it works

```text
Shared folder: application code + template + MANE reference files
      ↓ read by the designated Windows PC
Local Conda environment: plateapp → Python → Waitress → Flask app
      ↓
Local Windows data folder: SQLite database + session key
      ↑
Browser → HTTP request → application
```

The code can reside on the shared folder, but the running Python environment and live database stay on the Windows host. Keep access to the shared folder available while the app is running.

## Shared data for the laboratory

When started with `windows_server.py`, this version automatically publishes copies beneath the application folder:

```text
\\fs24-p04\okamura-lab-imaging\Hanai_app\96wellplatemap_app\
└── shared_data\
    ├── raw_data\
    │   └── <upload ID>\
    │       ├── original.xlsx          # Exact uploaded Excel file
    │       └── source.json            # Original filename, upload ID and upload time
    ├── metadata\
    │   └── 96well_metadata.xlsx        # Latest active plates, all wells and approvals
    ├── backups\
    │   └── plates_latest.sqlite3       # Full database snapshot, including history and Trash
    └── status.json                    # Time of the last fully completed export (UTC)
```

The app creates these folders automatically at startup and exports existing local records. It refreshes them after successful uploads, plate saves, approval changes and Trash operations. The Windows account running the app needs write access to the application folder. No additional Conda packages are required for this feature.

`raw_data` means uploaded Excel originals; it does not collect microscope images or other files that have not been uploaded. Upload IDs separate files with identical filenames. Plates entered directly in the app appear in the metadata and database snapshot, without an original Excel file.

Shared files are **exported copies**. Editing the exported workbook does not update the app automatically. All experimenters should use the same running Windows server to edit the common registry. Do not start a separate server per PC: separate Windows accounts and PCs have separate local databases and could overwrite the shared exports with different records.

The metadata workbook and database snapshot are replaced with the latest version; this is not a dated backup archive. Copy the database snapshot to a dated folder if you need long-term restore points. Exported raw originals are retained even if a plate is permanently purged in the app. Existing external copies are not erased by the app's purge operation.

A shared-folder outage or an Excel lock can prevent export. The local save remains successful, and an English warning with **Retry shared export** appears in the app. Close the shared workbook, reconnect to the share and retry. Until a successful retry, shared files may be stale or from different export times; `status.json` is updated only after all exports complete. Large uploads or a slow share can delay save responses.

### Update the already-running Windows installation

1. Stop the app with `Ctrl+C` in its Miniconda Prompt.
2. Copy the contents of this updated package into the existing `96wellplatemap_app` folder. Replace application files, but preserve any existing `shared_data` folder. Do not create a second nested app folder.
3. In the same Windows account as before, run:

```bat
conda activate plateapp
pushd "\\fs24-p04\okamura-lab-imaging\Hanai_app\96wellplatemap_app"
python windows_server.py
```

If you already use lab network access, keep your previous `--host 0.0.0.0 --port 5050` options and existing university-approved network settings. Startup prints both the local database path and shared-copy path. Confirm `shared_data/status.json` has a new timestamp.

## Local working database and restore

The Windows launcher stores data in the account that starts the application:

```text
%LOCALAPPDATA%\96wellSampleRegistry\data\
├── plates.sqlite3    # Plates, wells, history, Trash, approvals and uploaded originals
└── session.key       # Persistent browser-session signing key
```

You can paste `%LOCALAPPDATA%\96wellSampleRegistry\data` into the Windows Explorer address bar to find it.

- Updating these application files does not replace the local database.
- Different Windows PCs or accounts use different data folders. Use the same designated host and Windows account to continue working with the current data.
- This package contains **no experimental data**. An empty library on another PC does not mean the original records were deleted.
- For a backup, stop the app and copy `plates.sqlite3` to a dated backup folder. Keep `session.key` private. Restart the app after copying.
- For a restore or migration, stop the app, back up any existing destination database, then copy the intended `plates.sqlite3` into the local data folder. Databases are not automatically merged.
- Do not put the live SQLite database on SMB. Use the share for application files and the automatic exported copies described above.
- `All metadata Excel` exports the latest active plates, all 96 wells per plate, plate metadata and shared approvals. It excludes Trash, old revisions and uploaded originals, so it is not a complete database backup.

## Access from a Mac or another PC

The default command binds to `127.0.0.1`, so only the Windows host can connect. Opening that address on a Mac connects to the Mac itself.

The application currently has **no login, per-user permissions or built-in HTTPS**. Anyone who can reach its web port can read, modify, export and delete data. SMB folder permissions do not restrict web access. Before enabling network access, arrange lab-only network access and suitable authentication / HTTPS with university IT.

After those access controls have been arranged, stop the local server and run on the designated host:

```bat
conda activate plateapp
pushd "\\fs24-p04\okamura-lab-imaging\Hanai_app\96wellplatemap_app"
python windows_server.py --host 0.0.0.0 --port 5050
```

Other computers then open `http://WINDOWS-PC-NAME-OR-IP:5050` (or the HTTPS address provided by IT). Remote Desktop is not needed. `0.0.0.0` is a listening address, not a browser destination and not a lab-only access restriction. The Windows host must remain running and reachable.

## Troubleshooting

| Message or symptom | What to check |
|---|---|
| `conda` is not recognized | Open Anaconda Prompt / Miniconda Prompt. |
| `EnvironmentNameNotFound: plateapp` | Create the environment once from `environment.yaml`. |
| Environment already exists | Run `conda activate plateapp`; do not recreate it. |
| `requirements.txt` or `windows_server.py` not found | Run `pushd` again and check that `dir` lists those files. |
| `ModuleNotFoundError` | Activate `plateapp`, then run `python -m pip install -r requirements.txt`. |
| Permission, proxy or package-download error | Check the university installation / network policy with IT. |
| Port 5050 already in use | Stop the existing app window, or use `python windows_server.py --port 5051` and open port 5051. |
| The browser cannot connect | Keep the server window open and read its error output. Test on the Windows host first. |
| Old page or session error after restarting | Reload the browser page. |
| The library is unexpectedly empty | Check the printed database path and the Windows account / PC used to start the app. |

## Reference data

Human MANE GRCh38 v1.0 summary and RefSeq GTF are used locally for gene-name and intron-range checks. These checks do not identify the actual inserted intron or validate the experiment. Control labels and custom names can be reviewed in `Approved labels`.

## Package validation

This distribution was assembled from the current English application source. The runtime file list, bundled template, MANE references and application import were checked on the development Mac. The Windows Conda environment itself was not recreated on this Mac; the installed Windows setup and its data remain on the host PC.
