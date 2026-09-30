"""Windows launcher: code may live on SMB; runtime data stays on the host PC."""
import argparse
import os
from pathlib import Path
import secrets


def server_config(local_app_data):
    data_dir = Path(local_app_data) / '96wellSampleRegistry' / 'data'
    data_dir.mkdir(parents=True, exist_ok=True)
    secret_file = data_dir / 'session.key'
    try:
        with secret_file.open('x', encoding='ascii') as stream:
            stream.write(secrets.token_hex(32))
    except FileExistsError:
        pass
    return {'DATABASE': str(data_dir / 'plates.sqlite3'),
            'SHARED_DATA_DIR': str(Path(__file__).resolve().parent / 'shared_data'),
            'SECRET_KEY': secret_file.read_text(encoding='ascii').strip()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=5050)
    args = parser.parse_args()
    if os.name != 'nt' or not os.environ.get('LOCALAPPDATA'):
        parser.error('Run this launcher on Windows with LOCALAPPDATA available.')
    from waitress import serve
    from plate_app.app import create_app
    config = server_config(os.environ['LOCALAPPDATA'])
    app = create_app(config)
    status = app.extensions['shared_storage'].sync()
    print('Shared copies: ' + config['SHARED_DATA_DIR'], flush=True)
    if status['error']:
        print('WARNING: ' + status['error'], flush=True)
    print('Database: ' + config['DATABASE'], flush=True)
    print(f'Local browser: http://127.0.0.1:{args.port}', flush=True)
    if args.host != '127.0.0.1':
        print(f'Lab browser: http://<this-PC-name-or-IP>:{args.port}', flush=True)
    print('Keep this window open. Stop with Ctrl+C.', flush=True)
    serve(app, host=args.host, port=args.port, threads=4)


if __name__ == '__main__':
    main()
