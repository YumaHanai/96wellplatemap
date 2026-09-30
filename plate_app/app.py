from datetime import date, datetime, timezone
from io import BytesIO
import json
import os
import re
from pathlib import Path
import secrets
import sqlite3
from uuid import uuid4

from flask import Flask, jsonify, render_template, request, send_file, session, abort
from werkzeug.exceptions import HTTPException

from .workbooks import FIELDS, LOCATIONS, META_FIELDS, blank_wells, export_workbook, export_metadata, parse_workbook, meaningful
from .genes import check_wells, normalize_gene, normalize_stock, plate_summary, approval_matches


def create_app(test_config=None):
    app = Flask(__name__, instance_relative_config=True)
    app.config.update(MAX_CONTENT_LENGTH=12*1024*1024,
                      DATABASE=str(Path(app.instance_path) / 'plates.sqlite3'),
                      SECRET_KEY=os.environ.get('PLATE_SECRET_KEY') or secrets.token_hex(32),
                      SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE='Strict')
    if test_config:
        app.config.update(test_config)
    Path(app.config['DATABASE']).parent.mkdir(parents=True, exist_ok=True)

    def db():
        con = sqlite3.connect(app.config['DATABASE'], timeout=15)
        con.row_factory = sqlite3.Row
        return con

    with db() as con:
        con.executescript('''
        CREATE TABLE IF NOT EXISTS plates (
          id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, payload TEXT NOT NULL,
          version INTEGER NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS revisions (
          plate_id TEXT, version INTEGER, payload TEXT NOT NULL, saved_at TEXT,
          PRIMARY KEY(plate_id, version));
        CREATE TABLE IF NOT EXISTS uploads (
          id TEXT PRIMARY KEY, filename TEXT, raw BLOB, preview TEXT, created_at TEXT);
        CREATE TABLE IF NOT EXISTS trash (
          plate_id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS plate_lifecycle (
          plate_id TEXT, version INTEGER, action TEXT NOT NULL,
          PRIMARY KEY(plate_id, version));
        CREATE TABLE IF NOT EXISTS approved_labels (
          id TEXT PRIMARY KEY, field TEXT NOT NULL, value TEXT NOT NULL,
          reason TEXT NOT NULL, approved_by TEXT NOT NULL, approved_at TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1,
          UNIQUE(field,value));
        CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
        ''')
        if not con.execute("SELECT 1 FROM migrations WHERE name='shared_approvals_v1'").fetchone():
            for row in con.execute('SELECT payload FROM plates ORDER BY updated_at'):
                for a in json.loads(row['payload']).get('label_approvals', []):
                    con.execute('INSERT OR IGNORE INTO approved_labels VALUES (?,?,?,?,?,?,1,1)',
                                (uuid4().hex, a['field'], a['value'], a['reason'], a.get('approved_by', ''), a.get('approved_at', '')))
            con.execute("INSERT INTO migrations VALUES ('shared_approvals_v1')")

    def shared_approvals():
        with db() as con:
            return [dict(r) for r in con.execute('SELECT * FROM approved_labels ORDER BY field,value')]

    def label_checks(wells):
        return check_wells(wells, global_approvals=shared_approvals())

    @app.get('/api/approvals')
    def list_approvals():
        return jsonify(shared_approvals())

    @app.post('/api/approvals')
    def save_approval():
        data = request.get_json()
        if not isinstance(data, dict) or data.get('field') not in ('Gene_intron', 'Cell_Line_Stock'):
            raise ValueError('Invalid approval field.')
        for key, limit in [('value', 5000), ('reason', 2000), ('approved_by', 5000)]:
            if not isinstance(data.get(key), str) or not data[key].strip() or len(data[key]) > limit:
                raise ValueError('Enter the label, reason and approver.')
        if type(data.get('enabled', True)) not in (bool, int) or data.get('enabled', True) not in (True, False):
            raise ValueError('Invalid enabled / disabled setting.')
        value = (normalize_gene if data['field'] == 'Gene_intron' else normalize_stock)(data['value'])
        aid = data.get('id') or uuid4().hex
        try:
            with db() as con:
                con.execute('BEGIN IMMEDIATE')
                old = con.execute('SELECT * FROM approved_labels WHERE id=?', (aid,)).fetchone()
                if data.get('id') and not old:
                    abort(404, 'Approval not found.')
                if old and old['version'] != data.get('version'):
                    abort(409, 'This approval was updated in another window. Reopen the list.')
                version = old['version']+1 if old else 1
                con.execute('INSERT INTO approved_labels VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET '
                            'field=excluded.field,value=excluded.value,reason=excluded.reason,approved_by=excluded.approved_by,'
                            'approved_at=excluded.approved_at,enabled=excluded.enabled,version=excluded.version',
                            (aid, data['field'], value, data['reason'].strip(), data['approved_by'].strip(),
                             datetime.now(timezone.utc).isoformat(), int(data.get('enabled', True)), version))
        except sqlite3.IntegrityError:
            abort(409, 'This field and label already exist in the approval list. Edit the existing entry.')
        return jsonify(next(a for a in shared_approvals() if a['id'] == aid))

    @app.get('/api/wells')
    def all_wells():
        result = []
        with db() as con:
            rows = con.execute('SELECT * FROM plates WHERE id NOT IN (SELECT plate_id FROM trash) ORDER BY name').fetchall()
        for row in rows:
            p = json.loads(row['payload'])
            for loc in LOCATIONS:
                result.append(dict(plate_id=row['id'], plate=row['name'], loc=loc,
                                   metadata=p['metadata'], well=p['wells'][loc]))
        return jsonify(result)

    @app.before_request
    def protect_write():
        if request.method == 'POST' and (not session.get('csrf') or
                not secrets.compare_digest(request.headers.get('X-CSRF-Token', ''), session['csrf'])):
            abort(403, 'Reload the page before continuing.')

    @app.after_request
    def security_headers(response):
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'"
        return response

    @app.errorhandler(HTTPException)
    def http_error(error):
        return jsonify(error=error.description), error.code

    @app.errorhandler(ValueError)
    def value_error(error):
        return jsonify(error=str(error)), 400

    @app.get('/')
    def index():
        session.setdefault('csrf', secrets.token_hex(32))
        return render_template('index.html', csrf=session['csrf'])

    @app.get('/api/plates')
    def list_plates():
        with db() as con:
            rows = con.execute('SELECT * FROM plates WHERE id NOT IN (SELECT plate_id FROM trash) ORDER BY updated_at DESC').fetchall()
        result = []
        for row in rows:
            p = json.loads(row['payload'])
            result.append({'id': row['id'], 'plate': row['name'], 'metadata': p['metadata'],
                           'used': sum(any(meaningful(v) for v in w.values()) for w in p['wells'].values()),
                           'updated_at': row['updated_at'], 'version': row['version'],
                           'summary': plate_summary(p['wells'])})
        return jsonify(result)

    @app.get('/api/template')
    def download_template():
        return send_file(Path(app.root_path) / 'downloads' / '96wellplatemap_template.xlsx',
                         as_attachment=True, download_name='96wellplatemap_template.xlsx',
                         mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')

    def fetch_plate(plate_id):
        with db() as con:
            row = con.execute('SELECT * FROM plates WHERE id=? AND id NOT IN (SELECT plate_id FROM trash)', (plate_id,)).fetchone()
        if not row:
            abort(404, 'Plate not found.')
        p = json.loads(row['payload'])
        return dict(p, id=row['id'], version=row['version'], updated_at=row['updated_at'], gene_checks=label_checks(p['wells']))

    @app.post('/api/gene-check')
    def gene_check():
        data = request.get_json()
        wells = data.get('wells') if isinstance(data, dict) else None
        if not isinstance(wells, dict) or len(wells) > 96 or any(
                loc not in LOCATIONS or not isinstance(w, dict) or
                not isinstance(w.get('Gene_intron', ''), str) or len(w.get('Gene_intron', '')) > 5000
                for loc, w in wells.items()):
            raise ValueError('Invalid well information.')
        approvals = data.get('label_approvals', [])
        if not isinstance(approvals, list) or len(approvals) > 192 or any(not isinstance(a, dict) for a in approvals):
            raise ValueError('Invalid approval data.')
        return jsonify(label_checks(wells))

    @app.get('/api/plates/<plate_id>')
    def get_plate(plate_id):
        return jsonify(fetch_plate(plate_id))

    @app.post('/api/import')
    def import_excel():
        upload = request.files.get('file')
        if not upload or not upload.filename.lower().endswith('.xlsx'):
            raise ValueError('Select an .xlsx file.')
        raw = upload.read()
        try:
            preview = parse_workbook(raw)
        except ValueError:
            raise
        except Exception as exc:
            app.logger.info('Workbook rejected: %s', type(exc).__name__)
            raise ValueError('Could not read the Excel file. Check its format and whether it is damaged.') from exc
        token = uuid4().hex
        with db() as con:
            con.execute('INSERT INTO uploads VALUES (?,?,?,?,?)',
                        (token, Path(upload.filename).name, raw, json.dumps(preview, ensure_ascii=False),
                         datetime.now(timezone.utc).isoformat()))
        return jsonify(dict(preview, source_id=token, filename=Path(upload.filename).name))

    @app.get('/api/sources/<source_id>')
    def source(source_id):
        with db() as con:
            row = con.execute('SELECT * FROM uploads WHERE id=?', (source_id,)).fetchone()
        if not row:
            abort(404)
        return send_file(BytesIO(row['raw']), as_attachment=True, download_name=row['filename'])

    def validate(data):
        if not isinstance(data, dict):
            raise ValueError('Invalid input data.')
        name = data.get('plate')
        if not isinstance(name, str) or not name.strip() or len(name) > 100:
            raise ValueError('Enter a plate name between 1 and 100 characters.')
        metadata = data.get('metadata', {})
        wells = data.get('wells', {})
        if not isinstance(metadata, dict) or not isinstance(wells, dict) or set(wells) != set(LOCATIONS):
            raise ValueError('All 96 wells from A1 to H12 are required.')
        clean_meta = {}
        for key in META_FIELDS:
            value = metadata.get(key, '')
            if not isinstance(value, str) or len(value) > 5000:
                raise ValueError(f'{key}: Value is too long or has an invalid format.')
            clean_meta[key] = value.strip()
        if clean_meta['elab_experiment_id'] and not re.fullmatch(r'[0-9]{1,20}', clean_meta['elab_experiment_id']):
            raise ValueError('Use digits only for the eLabFTW experiment ID (up to 20 digits).')
        if not clean_meta['experimenter']:
            raise ValueError('Enter the experimenter name.')
        dates = []
        for key in ('seeding_date', 'treatment_date', 'fixation_date'):
            if clean_meta[key]:
                try:
                    dates.append(date.fromisoformat(clean_meta[key]))
                except ValueError as exc:
                    raise ValueError('Enter dates in YYYY-MM-DD format.') from exc
        if dates != sorted(dates):
            raise ValueError('Check that seeding, treatment and fixation dates are in chronological order.')
        cleaned = blank_wells()
        for loc, values in wells.items():
            if not isinstance(values, dict):
                raise ValueError(f'{loc}: Invalid well data.')
            for key in FIELDS:
                value = values.get(key, '')
                if not isinstance(value, str) or len(value) > 5000:
                    raise ValueError(f'{loc} / {key}: Value is too long or has an invalid format.')
                cleaned[loc][key] = value.strip()
        checks = check_wells(cleaned)
        for well in cleaned.values():
            well['Gene_intron'] = normalize_gene(well['Gene_intron'])
            well['Cell_Line_Stock'] = normalize_stock(well['Cell_Line_Stock'])
        approvals = data.get('label_approvals', [])
        if not isinstance(approvals, list) or len(approvals) > 192:
            raise ValueError('Invalid approval data.')
        previous = []
        if data.get('id'):
            with db() as con:
                old = con.execute('SELECT payload FROM plates WHERE id=?', (data['id'],)).fetchone()
            if old:
                previous = json.loads(old['payload']).get('label_approvals', [])
        clean_approvals = {}
        for approval in approvals:
            if not isinstance(approval, dict):
                raise ValueError('Invalid approval data.')
            loc, field = approval.get('loc'), approval.get('field')
            if loc not in LOCATIONS or field not in ('Gene_intron', 'Cell_Line_Stock'):
                raise ValueError('Invalid approval target.')
            reason = approval.get('reason', '')
            if not isinstance(reason, str) or not reason.strip() or len(reason) > 2000:
                raise ValueError('Enter an approval reason between 1 and 2,000 characters.')
            if not approval_matches(approval, loc, field, cleaned[loc]):
                continue
            old = next((a for a in previous if approval_matches(a, loc, field, cleaned[loc]) and a.get('reason') == reason.strip()), None)
            clean_approvals[(loc, field)] = {k: approval.get(k, '') for k in ('loc','field','value','cell_type','gene','stock')}
            clean_approvals[(loc, field)].update(reason=reason.strip(), approved_by=old['approved_by'] if old else clean_meta['experimenter'], approved_at=old['approved_at'] if old else datetime.now(timezone.utc).isoformat())
        result = {'plate': name.strip(), 'metadata': clean_meta, 'wells': cleaned,
                  'gene_corrections': checks['corrections'], 'label_approvals': list(clean_approvals.values())}
        # Legacy labels and warnings are derived from the preserved original, never client trusted.
        if data.get('source_id'):
            with db() as con:
                row = con.execute('SELECT preview FROM uploads WHERE id=?', (data['source_id'],)).fetchone()
            if not row:
                raise ValueError('Import source not found. Upload the file again.')
            candidates = json.loads(row['preview'])['plates']
            original = next((p for p in candidates if p['plate'] == data.get('source_plate')), None)
            if not original:
                raise ValueError('Invalid source plate.')
            result.update(source_id=data['source_id'], source_plate=data['source_plate'],
                          legacy_map=original['legacy_map'], warnings=original['warnings'])
        return result

    @app.post('/api/plates')
    def save_plate():
        data = request.get_json()
        p = validate(data)
        plate_id = data.get('id') or uuid4().hex
        stamp = datetime.now(timezone.utc).isoformat()
        payload = json.dumps(p, ensure_ascii=False)
        try:
            with db() as con:
                con.execute('BEGIN IMMEDIATE')
                if con.execute('SELECT 1 FROM trash WHERE plate_id=?', (plate_id,)).fetchone():
                    abort(409, 'This plate is in Trash. Refresh the library or restore the plate from Trash.')
                old = con.execute('SELECT version FROM plates WHERE id=?', (plate_id,)).fetchone()
                if data.get('id') and not old:
                    abort(404, 'The plate to update was not found.')
                if old and old['version'] != data.get('version'):
                    abort(409, 'This plate was updated in another window. Keep a copy of your edits, then reopen the plate.')
                version = old['version'] + 1 if old else 1
                con.execute('INSERT INTO plates VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET '
                            'name=excluded.name,payload=excluded.payload,version=excluded.version,updated_at=excluded.updated_at',
                            (plate_id, p['plate'], payload, version, stamp))
                con.execute('INSERT INTO revisions VALUES (?,?,?,?)', (plate_id, version, payload, stamp))
        except sqlite3.IntegrityError as exc:
            abort(409, 'A plate with this name already exists, including in Trash. Choose another name, or open or restore the existing plate.')
        return jsonify(dict(p, id=plate_id, version=version, updated_at=stamp, gene_checks=label_checks(p['wells'])))

    @app.get('/api/plates/<plate_id>/history')
    def history(plate_id):
        fetch_plate(plate_id)
        with db() as con:
            rows = con.execute('SELECT r.version,r.saved_at,r.payload,COALESCE(l.action,\'save\') AS action '
                               'FROM revisions r LEFT JOIN plate_lifecycle l ON r.plate_id=l.plate_id AND r.version=l.version '
                               'WHERE r.plate_id=? ORDER BY r.version DESC',
                               (plate_id,)).fetchall()
        return jsonify([dict(version=r['version'], saved_at=r['saved_at'], action=r['action'], data=json.loads(r['payload'])) for r in rows])

    @app.get('/api/trash')
    def list_trash():
        with db() as con:
            rows = con.execute('SELECT p.id,p.name,p.version,t.deleted_at FROM plates p '
                               'JOIN trash t ON p.id=t.plate_id ORDER BY t.deleted_at DESC').fetchall()
        return jsonify([dict(id=r['id'], plate=r['name'], version=r['version'], deleted_at=r['deleted_at']) for r in rows])

    @app.post('/api/plates/<plate_id>/<action>')
    def change_lifecycle(plate_id, action):
        if action not in ('trash', 'restore', 'purge'):
            abort(404)
        data = request.get_json()
        if not isinstance(data, dict) or type(data.get('version')) is not int:
            raise ValueError('Plate version is required. Reopen the plate.')
        stamp = datetime.now(timezone.utc).isoformat()
        with db() as con:
            con.execute('BEGIN IMMEDIATE')
            row = con.execute('SELECT * FROM plates WHERE id=?', (plate_id,)).fetchone()
            if not row:
                abort(404, 'Plate not found.')
            in_trash = bool(con.execute('SELECT 1 FROM trash WHERE plate_id=?', (plate_id,)).fetchone())
            if row['version'] != data['version'] or in_trash != (action in ('restore', 'purge')):
                abort(409, 'The plate state has changed. Reopen the view.')
            if action == 'purge':
                if data.get('confirm_name') != row['name']:
                    raise ValueError('The confirmation name does not match the plate name.')
                payloads = [row['payload']] + [r['payload'] for r in con.execute('SELECT payload FROM revisions WHERE plate_id=?', (plate_id,))]
                source_ids = {json.loads(p).get('source_id') for p in payloads} - {None, ''}
                con.execute('DELETE FROM revisions WHERE plate_id=?', (plate_id,))
                con.execute('DELETE FROM plate_lifecycle WHERE plate_id=?', (plate_id,))
                con.execute('DELETE FROM trash WHERE plate_id=?', (plate_id,))
                con.execute('DELETE FROM plates WHERE id=?', (plate_id,))
                remaining = {json.loads(r['payload']).get('source_id') for r in con.execute('SELECT payload FROM plates UNION ALL SELECT payload FROM revisions')}
                for source_id in source_ids - remaining:
                    con.execute('DELETE FROM uploads WHERE id=?', (source_id,))
                return jsonify(id=plate_id, action=action)
            version = row['version'] + 1
            if action == 'trash':
                con.execute('INSERT INTO trash VALUES (?,?)', (plate_id, stamp))
            else:
                con.execute('DELETE FROM trash WHERE plate_id=?', (plate_id,))
            con.execute('UPDATE plates SET version=?,updated_at=? WHERE id=?', (version, stamp, plate_id))
            con.execute('INSERT INTO revisions VALUES (?,?,?,?)', (plate_id, version, row['payload'], stamp))
            con.execute('INSERT INTO plate_lifecycle VALUES (?,?,?)', (plate_id, version, action))
        return jsonify(id=plate_id, version=version, action=action)

    @app.get('/api/export/metadata')
    def download_metadata():
        with db() as con:
            con.execute('BEGIN')
            rows = con.execute('SELECT * FROM plates WHERE id NOT IN (SELECT plate_id FROM trash) ORDER BY name').fetchall()
            approvals = [dict(r) for r in con.execute('SELECT * FROM approved_labels ORDER BY field,value')]
        plates = [dict(json.loads(r['payload']), id=r['id'], version=r['version'], updated_at=r['updated_at']) for r in rows]
        stamp = datetime.now(timezone.utc)
        return send_file(export_metadata(plates, approvals, stamp.isoformat()), as_attachment=True,
                         download_name=f'96well_metadata_{stamp:%Y%m%d_%H%M%S}.xlsx',
                         mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')

    @app.get('/api/export/<kind>')
    def export(kind):
        if kind not in ('plates', 'platemaps'):
            abort(404)
        if request.args.get('id'):
            plates = [fetch_plate(request.args['id'])]
        else:
            with db() as con:
                plates = [json.loads(r['payload']) for r in con.execute('SELECT payload FROM plates WHERE id NOT IN (SELECT plate_id FROM trash) ORDER BY name')]
        if not plates:
            raise ValueError('Register a plate first.')
        return send_file(export_workbook(plates, kind == 'platemaps'), as_attachment=True,
                         download_name=f'Screening_96well_{kind}.xlsx',
                         mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')

    return app


if __name__ == '__main__':
    create_app().run(host='127.0.0.1', port=int(os.environ.get('PORT', '5050')), debug=False)
